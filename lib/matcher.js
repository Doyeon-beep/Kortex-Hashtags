import { exactMatchCategories, exactMatchBrands, matchAnyInCategories, matchAnyInBrands } from "./sheetQuery";
import { stemVariants } from "./stem";
import { ABBREVIATIONS, expandAbbreviation } from "./abbreviations";
import { looksNonEnglish, translateToEnglish } from "./translate";

const MIN_PART_LENGTH = 3;

// The 9 "main vertical" cat1 values take priority over every other cat1
// ("affinity group") when the same segment matches both — per the
// guideline's "Cat1 Priority" rule. Compared with whitespace/case removed
// so "home & pet" and "home&pet" both match.
const MAIN_VERTICALS_NORM = new Set(
  [
    "beauty",
    "personal care",
    "wellness",
    "home & pet",
    "cultural shifts",
    "grocery",
    "beverages",
    "culinary",
    "occasions",
  ].map((s) => s.replace(/\s+/g, "").toLowerCase())
);

function isMainVertical(cat1) {
  return MAIN_VERTICALS_NORM.has(String(cat1 || "").replace(/\s+/g, "").toLowerCase());
}

// If a segment matches both a main-vertical cat1 and an affinity-group
// cat1, keep only the main-vertical match(es) — the affinity-group ones
// are dropped as duplicates rather than shown alongside it.
function preferMainVertical(matches) {
  const mainMatches = matches.filter((m) => isMainVertical(m.cat1));
  return mainMatches.length > 0 ? mainMatches : matches;
}

function rowToPath(row) {
  const [cat1, cat2, cat3, cat4, cat5] = row;
  return { cat1, cat2, cat3, cat4, cat5 };
}

// Exact + stem + abbreviation lookup for a single literal word/phrase, with
// no splitting and no research fallback. Used both by matchSegment() itself
// and by the compound-splitting step below (trySegmentCompound), so a
// candidate half of a split hashtag gets the same three free-tier checks a
// full hashtag would.
//
// All candidate queries (the exact word, every stem variant, and the
// abbreviation expansion) now fire in ONE parallel batch instead of one
// sequential round-trip after another. This used to be the main hidden cost
// of compound-splitting: trySegmentCompound calls this twice (or three
// times) per candidate split, and it tries dozens of splits for a long
// hashtag — at up to ~5 sequential network round-trips per call before,
// that added up to potentially minutes for a single hard hashtag. Now each
// call only takes as long as its single slowest query.
async function lookupWordOnly(word) {
  const variants = stemVariants(word);
  const expanded = expandAbbreviation(word);
  const queries = [word, ...variants, ...(expanded ? [expanded] : [])];
  const results = await Promise.all(queries.map((q) => exactMatchCategories(q)));

  const [exact, ...rest] = results;
  if (exact.status === "error") return { status: "error", error: exact.error };
  if (exact.rows.length > 0) {
    return { status: "ok", matches: preferMainVertical(exact.rows.map(rowToPath)) };
  }

  const stemResults = expanded ? rest.slice(0, -1) : rest;
  for (const res of stemResults) {
    if (res.status === "ok" && res.rows.length > 0) {
      return { status: "ok", matches: preferMainVertical(res.rows.map(rowToPath)) };
    }
  }

  if (expanded) {
    const expandedResult = rest[rest.length - 1];
    if (expandedResult.status === "error") return { status: "error", error: expandedResult.error };
    if (expandedResult.rows.length > 0) {
      return { status: "ok", matches: preferMainVertical(expandedResult.rows.map(rowToPath)) };
    }
  }

  return { status: "none" };
}

const COLUMN_INDEX = { A: 0, B: 1, C: 2, D: 3, E: 4 };

// Steps 1, 1b, 1c, 2, 3, 3.4 combined into exactly 2 requests (one for the
// categories tab, one for brands) instead of a dozen-plus sequential ones.
//
// Each of those steps used to be its own network round trip: exact match,
// brand exact match, several stem variants checked ONE AT A TIME, an
// abbreviation-expansion check, a space-inserted combined-phrase check (2
// requests), then cat4/cat3/cat2 fallback checks. Individually each is fine,
// but Google's gviz endpoint has real latency (a couple of seconds even when
// nothing is wrong) — stacked sequentially, that was consistently eating
// 20-30+ seconds of a hashtag's total time budget before it ever reached AI
// research, even after capping the worst single offender
// (COMPOUND_SPLIT_BUDGET_MS). Since every one of these checks is really just
// "does the sheet have a row where column X equals value Y", they can all be
// asked in ONE OR'd query per tab and resolved in JS afterward — the number
// of conceptual match strategies no longer costs extra network round trips.
//
// `checks` is ordered by priority: the first entry with a matching row wins,
// exactly matching the original step order (exact cat5 > exact brand >
// stemmed > abbreviation > combined phrase (cat5, then brand) > cat4 partial
// > cat3 partial > cat2 partial).
async function matchAllFreeCandidates(segment) {
  const stems = stemVariants(segment);
  const expanded = expandAbbreviation(segment);
  const n = segment.length;
  const combinedPhrases = [];
  for (let i = MIN_PART_LENGTH; i <= n - MIN_PART_LENGTH; i++) {
    combinedPhrases.push(`${segment.slice(0, i)} ${segment.slice(i)}`);
  }

  const checks = [
    { source: "cat", column: "E", value: segment, statusLabel: "exact" },
    { source: "brand", column: "A", value: segment, statusLabel: "exact_brand" },
    ...stems.map((s) => ({
      source: "cat",
      column: "E",
      value: s,
      statusLabel: "stemmed",
      note: `matched via stemmed form "${s}"`,
    })),
    ...(expanded
      ? [
          {
            source: "cat",
            column: "E",
            value: expanded,
            statusLabel: "abbreviation",
            note: `expanded abbreviation "${segment}" -> "${expanded}"`,
          },
        ]
      : []),
    ...combinedPhrases.map((p) => ({
      source: "cat",
      column: "E",
      value: p,
      statusLabel: "exact",
      note: `matched as combined phrase "${p}"`,
    })),
    ...combinedPhrases.map((p) => ({
      source: "brand",
      column: "A",
      value: p,
      statusLabel: "exact_brand",
      note: `matched brand as combined phrase "${p}"`,
    })),
    { source: "cat", column: "D", value: segment, statusLabel: "partial", depth: 4 },
    { source: "cat", column: "C", value: segment, statusLabel: "partial", depth: 3 },
    { source: "cat", column: "B", value: segment, statusLabel: "partial", depth: 2 },
  ];

  const [catResult, brandResult] = await Promise.all([
    matchAnyInCategories(checks.filter((c) => c.source === "cat")),
    matchAnyInBrands(checks.filter((c) => c.source === "brand")),
  ]);
  if (catResult.status === "error") return { status: "error", error: catResult.error };
  if (brandResult.status === "error") return { status: "error", error: brandResult.error };

  for (const check of checks) {
    const rowSet = check.source === "cat" ? catResult.rows : brandResult.rows;
    const idx = COLUMN_INDEX[check.column];
    const rows = rowSet.filter((r) => r[idx] === check.value);
    if (rows.length === 0) continue;

    if (check.statusLabel === "exact_brand") {
      return {
        status: "ok",
        found: {
          statusLabel: "exact_brand",
          matches: rows.map(([brand, productLine]) => ({ brand, productLine })),
          note: check.note,
        },
      };
    }

    if (check.statusLabel === "partial") {
      const seen = new Set();
      const matches = [];
      for (const row of rows) {
        const path = rowToPath(row);
        // Blank out EVERYTHING deeper than the level that actually matched —
        // we only confirmed the word means THIS level, nothing more specific.
        // A cat2 like "skincare" can have many cat3 children ("face
        // concerns", "skincare products", "sun care & tanning", ...), so
        // matching only at cat2 must blank cat3 too, not just cat4/cat5 —
        // otherwise every one of those unrelated cat3 children turns into
        // its own separate (wrong) row instead of one deduped cat2-only row.
        path.cat5 = "";
        if (check.depth < 4) path.cat4 = "";
        if (check.depth < 3) path.cat3 = "";
        const key = `${path.cat1}|${path.cat2}|${path.cat3}|${path.cat4}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(path);
      }
      return {
        status: "ok",
        found: {
          statusLabel: "partial",
          matches: preferMainVertical(matches),
          note: `matched at cat${check.depth} level only — no more specific cat5 exists for this literal word`,
        },
      };
    }

    return {
      status: "ok",
      found: { statusLabel: check.statusLabel, matches: preferMainVertical(rows.map(rowToPath)), note: check.note },
    };
  }

  return { status: "ok", found: null };
}

// Step 3.5: hashtags never contain spaces, so a compound like "scalpshampoo"
// or "dfwblackhair" only matches the sheet once it's split into its real
// words ("scalp" + "shampoo"). Try 2-way splits first (fewer parts = safer,
// per the guideline's "don't over-segment" rule), then 3-way only if no
// 2-way split works. Every candidate half/third must independently match
// the sheet (exact/stem/abbreviation) — nothing is invented. No note is
// recorded for a clean split like this since each piece is already a plain
// exact/stem/abbreviation match — nothing worth flagging for review.
//
// A long hashtag has a LOT of possible 2-way/3-way split points (a 20-char
// segment alone is ~15 two-way + ~80 three-way combinations), each needing
// its own round of sheet queries — exhaustively trying all of them was the
// real reason a single hard hashtag could take minutes even before it ever
// reached the AI step. COMPOUND_SPLIT_BUDGET_MS caps how long this whole
// search is allowed to run; past that, give up and fall through to AI
// research (which is time-boxed separately, see RESEARCH_DEADLINE_MS in
// claudeResearch.js) rather than grinding through every remaining
// combination.
// This used to be 20000 (20s) — for a hashtag that's genuinely novel (no
// existing independent-word split to find, which is most of them: brand-like
// names, city+profession combos, etc.), that meant grinding through nearly
// the full 20s before ever reaching research anyway, out of route.js's
// overall 50s-per-hashtag budget (HASHTAG_TIMEOUT_MS) — leaving research as
// little as ~15s to work with, not enough for even one meaningful tool-use
// turn. Lowered so a hashtag this step can't help with fails fast and hands
// research a usable amount of the remaining budget instead.
const COMPOUND_SPLIT_BUDGET_MS = 6000;

async function trySegmentCompound(segment) {
  const n = segment.length;
  const deadline = Date.now() + COMPOUND_SPLIT_BUDGET_MS;

  for (let i = MIN_PART_LENGTH; i <= n - MIN_PART_LENGTH; i++) {
    if (Date.now() > deadline) return null;
    const left = segment.slice(0, i);
    const right = segment.slice(i);
    const [leftRes, rightRes] = await Promise.all([lookupWordOnly(left), lookupWordOnly(right)]);
    if (leftRes.status === "ok" && rightRes.status === "ok") {
      return { parts: [left, right], matches: [...leftRes.matches, ...rightRes.matches] };
    }
  }

  if (n >= MIN_PART_LENGTH * 3) {
    for (let i = MIN_PART_LENGTH; i <= n - MIN_PART_LENGTH * 2; i++) {
      for (let j = i + MIN_PART_LENGTH; j <= n - MIN_PART_LENGTH; j++) {
        if (Date.now() > deadline) return null;
        const p1 = segment.slice(0, i);
        const p2 = segment.slice(i, j);
        const p3 = segment.slice(j);
        const [r1, r2, r3] = await Promise.all([
          lookupWordOnly(p1),
          lookupWordOnly(p2),
          lookupWordOnly(p3),
        ]);
        if (r1.status === "ok" && r2.status === "ok" && r3.status === "ok") {
          return { parts: [p1, p2, p3], matches: [...r1.matches, ...r2.matches, ...r3.matches] };
        }
      }
    }
  }

  return null;
}

// Step 3.6: a known abbreviation can be glued directly onto another word
// with no split point that works either side (e.g. "dfwblackhair" - "dfw"
// deterministically expands to "dallas-fort worth" via our own dictionary,
// but the remainder "blackhair" needs a space ("black hair") that
// trySegmentCompound's plain substring splitting can never produce, so
// steps 1-3.5 on the whole string never separate them). Peel off the known
// abbreviation ourselves — it's a small closed dictionary we already trust
// completely, no reason to make the (much less reliable, guess-prone) AI
// research step rediscover it — and only hand the smaller leftover text to
// research, instead of the whole ambiguous string.
async function tryPeelAbbreviation(segment) {
  const lower = segment.toLowerCase();
  for (const abbr of Object.keys(ABBREVIATIONS)) {
    // 2-letter abbreviations (ca, fl, sc, tx, nj, av...) are excluded here.
    // They're real US-state abbreviations when a segment IS exactly that
    // string ("ca" alone still expands fine via Step 3 in matchSegment), but
    // as a glued-on PREFIX/SUFFIX of a longer word they collide constantly
    // with ordinary English ("candyshop" starts with "ca", "catnecessities"
    // starts with "ca") and silently produce a wrong, confidently-reported
    // split (confirmed against a real 50-hashtag test: #candyshop🍭 and
    // #catnecessities both got mangled this way). 3+ letter abbreviations
    // (dfw, pdx, atl, pnw, mua) are unambiguous enough as substrings to keep.
    if (abbr.length < 3) continue;
    const expanded = ABBREVIATIONS[abbr];

    if (lower.startsWith(abbr) && lower.length - abbr.length >= MIN_PART_LENGTH) {
      const res = await exactMatchCategories(expanded);
      if (res.status === "ok" && res.rows.length > 0) {
        return {
          abbrPart: segment.slice(0, abbr.length),
          remainder: segment.slice(abbr.length),
          matches: preferMainVertical(res.rows.map(rowToPath)),
          expanded,
        };
      }
    }

    if (lower.endsWith(abbr) && lower.length - abbr.length >= MIN_PART_LENGTH) {
      const res = await exactMatchCategories(expanded);
      if (res.status === "ok" && res.rows.length > 0) {
        return {
          abbrPart: segment.slice(segment.length - abbr.length),
          remainder: segment.slice(0, segment.length - abbr.length),
          matches: preferMainVertical(res.rows.map(rowToPath)),
          expanded,
        };
      }
    }
  }
  return null;
}

// Runs steps 1-3.5 of the guideline's "매칭 절차" for a single literal segment.
// Step 4 (TikTok/Google research + new-entity proposal) is handled
// separately by lib/claudeResearch.js, only when this returns
// status: "needs_research".
export async function matchSegment(rawSegment) {
  let segment = rawSegment.trim();
  const notes = [];

  // Step 0 (translation gate): non-English segments must be translated
  // before exact/stem matching, since the sheet's own values are English.
  if (looksNonEnglish(segment)) {
    const { translated, skipped } = await translateToEnglish(segment);
    if (translated) {
      notes.push(`translated "${rawSegment}" -> "${translated}"`);
      segment = translated;
    } else if (skipped) {
      notes.push("non-English segment, no translation available — sending to research step");
      return { status: "needs_research", segment: rawSegment, notes };
    }
  }

  // Steps 1, 1b, 1c, 2, 3, 3.4: exact cat5 match, exact brand match, stemmed
  // forms, abbreviation expansion, space-inserted combined phrase, and
  // cat2/3/4 fallback — all resolved together in 2 total requests (see
  // matchAllFreeCandidates above). The priority order there matches the
  // original step order exactly, including "whole-word cat2/3/4 fallback
  // before independent-word splitting" (so a coherent single word like
  // "skincare" is recognized as itself rather than being torn into two
  // unrelated halves by trySegmentCompound below).
  const combinedResult = await matchAllFreeCandidates(segment);
  if (combinedResult.status === "error") {
    return { status: "error", segment: rawSegment, error: combinedResult.error, notes };
  }
  if (combinedResult.found) {
    const { statusLabel, matches, note } = combinedResult.found;
    if (note) notes.push(note);
    return { status: statusLabel, segment: rawSegment, matches, notes };
  }

  // Step 3.5: no single-string match — try splitting into multiple known
  // words, since hashtags have no spaces (e.g. "scalpshampoo" -> "scalp" +
  // "shampoo"). This still costs nothing (just more sheet lookups), so it
  // runs before the paid AI research step. No note is added — a clean
  // split into already-matching pieces doesn't need a review comment.
  const split = await trySegmentCompound(segment);
  if (split) {
    return { status: "segmented", segment: rawSegment, matches: split.matches, notes };
  }

  // Step 3.6: try peeling off a known abbreviation glued to the rest of the
  // word (see tryPeelAbbreviation above for why this needs its own step).
  const peeled = await tryPeelAbbreviation(segment);
  if (peeled) {
    const remainderResult = await matchSegment(peeled.remainder);
    if (remainderResult.status !== "needs_research" && remainderResult.status !== "error") {
      // The leftover text also resolves through the free tier on its own —
      // combine both confirmed parts, no AI research needed at all.
      return {
        status: "segmented",
        segment: rawSegment,
        matches: [...peeled.matches, ...(remainderResult.matches || [])],
        notes: [
          ...notes,
          `expanded known abbreviation "${peeled.abbrPart}" -> "${peeled.expanded}"`,
          ...remainderResult.notes,
        ],
      };
    }
    // Leftover text still needs AI research — keep the confident,
    // deterministic abbreviation match, and only send the smaller leftover
    // to research instead of letting the AI re-guess the whole string
    // (including the part we already know for certain).
    notes.push(
      `expanded known abbreviation "${peeled.abbrPart}" -> "${peeled.expanded}"; remaining "${peeled.remainder}" needs research`
    );
    return {
      status: "needs_research",
      segment: rawSegment,
      notes,
      partialMatches: peeled.matches,
      researchSegment: peeled.remainder,
    };
  }

  // Nothing matched — hand off to step 4 (research).
  return { status: "needs_research", segment: rawSegment, notes };
}
