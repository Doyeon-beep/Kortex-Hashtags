import { NextResponse } from "next/server";
import { matchSegment } from "../../../lib/matcher";
import { researchNewEntity } from "../../../lib/claudeResearch";
import { reconcileConsistency } from "../../../lib/consistency";

// Emoji embedded in a hashtag (e.g. a flag emoji) has no taxonomy meaning
// and was causing garbled classification when matching/research tried to
// interpret it as literal content - strip it deterministically before any
// matching starts, rather than leaving it to the AI to guess whether/how to
// read it. \p{Extended_Pictographic} covers pictographic emoji without also
// matching plain digits (unlike the broader \p{Emoji} property, which would
// wrongly strip characters like "2" out of a hashtag such as "#2in1makeup").
// Regional-indicator flag pairs (e.g. the US flag) aren't Extended_Pictographic,
// so they're matched separately by their code point range; ‍ (zero-width
// joiner) and ️ (variation selector-16) are stripped too since they
// often glue multi-part emoji (like a flag) together with other characters.
const EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}\p{Extended_Pictographic}\u200D\uFE0F]/gu;

function stripEmoji(text) {
  return text.replace(EMOJI_RE, "");
}

// Tries the hashtag as a single combined phrase first (per the "don't
// default to smallest units" rule) via exact match / stem / abbreviation.
// Hashtags that need real word-segmentation (e.g. "dfwblackhair" -> "dfw" +
// "black hair") or a brand-new entity proposal come back as
// "needs_research" from the free-tier matcher; if useResearch is on, those
// get sent to the Claude API step (task #8), which costs money — off by
// default so nobody burns API credits without opting in.

// Hashtags used to be processed one at a time in a plain for-loop, which is
// why a batch of AI-heavy hashtags could take many minutes — nothing ran
// until the previous hashtag's entire (up to 6-turn) research call finished.
// Now up to CONCURRENCY hashtags are in flight at once. This is deliberately
// NOT unlimited Promise.all(): firing many at once multiplies concurrent
// Anthropic API + Google Sheets gviz requests by that same factor, which
// risks tripping rate limits — especially on a fresh/Start-tier API account,
// where several hashtags' multi-turn research loops competing for the same
// per-minute quota can cause cascading 429s. This was raised from 3 to 5
// once already assuming that was safe; instead, batches got SLOWER (more
// concurrent calls colliding with the rate limit → more retries → more total
// wait time), not faster. Lowered to 2 now as a more conservative default —
// raise it again once actual account limits are confirmed (check the Claude
// Console's rate-limit tab, or watch the server logs for "status 429").
// Without this, Vercel enforces its platform default duration limit (short —
// well under a minute on Hobby), which silently kills this function long
// before any of the internal timeouts below (claudeResearch.js's
// RESEARCH_DEADLINE_MS, sheetQuery.js's GVIZ_TIMEOUT_MS) ever get a chance to
// fire. That mismatch — not the internal timeouts themselves — was the actual
// cause of "Failed to fetch" on every hashtag that needed AI research: the
// connection was severed by the platform mid-request, so the browser never
// got a real HTTP response to show a proper error for.
// 300s is Vercel Pro's standard ceiling without needing Fluid Compute
// specifically enabled (Hobby's was 60s — this project moved to a Pro team
// account). If Fluid Compute is confirmed on for this project, this can go
// higher (up to 800s), but 300 is the safe assumption either way.
export const maxDuration = 300;

const CONCURRENCY = 2;

// Hard ceiling for ONE hashtag's ENTIRE resolution — matchSegment()'s free-tier
// lookup chain PLUS the AI research step, combined. Must stay safely under
// maxDuration (300s) — kept well below it since two hashtags run concurrently
// per request (CONCURRENCY below) and route.js still needs time to reconcile
// and serialize the response after both finish. Hands whatever's left of this
// budget to research dynamically instead of always spending a fixed amount
// regardless of how much matching already used.
const HASHTAG_TIMEOUT_MS = 280000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`"${label}" exceeded its ${ms / 1000}s time budget`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Resolves a single hashtag end-to-end (matcher + optional AI research) and
// returns the list of result rows it produces (usually 1, sometimes more —
// see the abbreviation-peeling and multi-concept-splitting cases below).
// Wrapped in try/catch so one hashtag's failure (a sheet-query network blip,
// an Anthropic API error that survived its own internal retries, etc.)
// can't take down the whole batch or leave the request hanging — it becomes
// its own reviewable "error" row instead.
async function resolveHashtagInner(hashtag, useResearch, deadlineAt) {
  const segment = stripEmoji(hashtag.replace(/^#/, ""));
  const match = await matchSegment(segment);

  if (match.status !== "needs_research") {
    return [{ hashtag, ...match }];
  }

  const rows = [];
  // A known abbreviation may already have been peeled off deterministically
  // (see matcher.js's tryPeelAbbreviation) — if so, keep that confirmed
  // part as its own row and only research the smaller leftover text,
  // instead of letting the AI re-guess the whole original string.
  if (match.partialMatches && match.partialMatches.length > 0) {
    rows.push({ hashtag, status: "segmented", segment: match.segment, matches: match.partialMatches, notes: [] });
  }
  const researchTarget = match.researchSegment || segment;
  if (useResearch) {
    // Whatever's left of this hashtag's overall budget after matchSegment
    // already spent some of it — not a fresh fixed amount every time.
    const remainingMs = Math.max(deadlineAt - Date.now(), 3000);
    const research = await researchNewEntity(researchTarget, hashtag, remainingMs);
    rows.push({ hashtag, ...match, research });
  } else {
    rows.push({ hashtag, ...match });
  }
  return rows;
}

// A well-formed hashtag: exactly one "#", at the very start, and no commas
// or periods anywhere in it. Checked before any matching/research work
// starts — an input that doesn't even look like a hashtag isn't something
// matching or AI research should try to interpret, it's just a formatting
// mistake to flag back to whoever pasted it in.
const HASHTAG_FORMAT_RE = /^#[^#,.]+$/;

async function resolveHashtag(hashtag, useResearch) {
  if (!HASHTAG_FORMAT_RE.test(hashtag)) {
    return [{ hashtag, status: "invalid_format", notes: [] }];
  }

  const deadlineAt = Date.now() + HASHTAG_TIMEOUT_MS;
  try {
    return await withTimeout(resolveHashtagInner(hashtag, useResearch, deadlineAt), HASHTAG_TIMEOUT_MS, hashtag);
  } catch (err) {
    // Log the real error server-side (terminal running `npm run dev`, or the
    // hosting provider's function logs) — the UI only ever shows a short
    // message, so this is the only place the actual cause (network error,
    // Anthropic error code/status, etc.) is visible for debugging.
    console.error(`[classify] "${hashtag}" failed:`, err?.status ? `status ${err.status} — ` : "", err);
    return [
      {
        hashtag,
        status: "error",
        error: err?.message || "Unknown error while classifying this hashtag",
        notes: [],
      },
    ];
  }
}

export async function POST(request) {
  const body = await request.json();
  const hashtags = Array.isArray(body.hashtags) ? body.hashtags : [];
  const useResearch = Boolean(body.useResearch);

  const cleaned = hashtags.map((raw) => raw.trim()).filter(Boolean);

  const startedAt = Date.now();
  const perHashtagRows = await mapWithConcurrency(cleaned, CONCURRENCY, (hashtag) =>
    resolveHashtag(hashtag, useResearch)
  );
  const elapsedMs = Date.now() - startedAt;
  const results = perHashtagRows.flat();

  // A hashtag "needed AI research" if any row it produced came back from
  // matchSegment() with status "needs_research" - counted per-hashtag (not
  // per-row) since one hashtag can produce multiple rows. Logged server-side
  // (visible in Vercel's function logs) and returned to the client so a
  // whole run's totals can be shown in the UI - this is the only place that
  // actually knows both numbers, since the free-tier matcher and the AI
  // research step are otherwise opaque to whoever's waiting on the batch.
  const researchCount = perHashtagRows.filter((rows) => rows.some((r) => r.status === "needs_research")).length;
  console.log(
    `[classify] batch of ${cleaned.length} (${researchCount} needed AI research) took ${elapsedMs}ms`
  );

  const { results: reconciled, flags } = reconcileConsistency(results);

  return NextResponse.json({
    results: reconciled,
    consistencyFlags: flags,
    meta: { total: cleaned.length, researchCount, elapsedMs },
  });
}
