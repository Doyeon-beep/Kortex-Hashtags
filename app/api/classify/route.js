import { NextResponse } from "next/server";
import { matchSegment } from "../../../lib/matcher";
import { researchNewEntity } from "../../../lib/claudeResearch";
import { reconcileConsistency } from "../../../lib/consistency";

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
// 60 is Hobby's historical safe ceiling; raise this only after confirming a
// higher one in the Vercel dashboard (Project Settings -> Functions).
export const maxDuration = 60;

const CONCURRENCY = 2;

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
async function resolveHashtag(hashtag, useResearch) {
  try {
    const segment = hashtag.replace(/^#/, "");
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
      const research = await researchNewEntity(researchTarget, hashtag);
      rows.push({ hashtag, ...match, research });
    } else {
      rows.push({ hashtag, ...match });
    }
    return rows;
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

  const perHashtagRows = await mapWithConcurrency(cleaned, CONCURRENCY, (hashtag) =>
    resolveHashtag(hashtag, useResearch)
  );
  const results = perHashtagRows.flat();

  const { results: reconciled, flags } = reconcileConsistency(results);

  return NextResponse.json({ results: reconciled, consistencyFlags: flags });
}
