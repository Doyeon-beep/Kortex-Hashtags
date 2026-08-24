import {
  exactMatchCategories,
  exactMatchBrands,
  matchCategoryColumn,
  matchAnyExactCategories,
  matchAnyExactBrands,
} from "./sheetQuery";
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

// Step 1c: hashtags never contain spaces, so a combined multi-word cat5
// value (e.g. "lower eyelashes") only exists in the sheet WITH a space, but
// arrives here as one unbroken string. Before ever trying to split the
// hashtag into multiple SEPARATE, unrelated concepts (trySegmentCompound
// below — which requires each half to independently exist on its own),
// check every point a space plausibly belongs and see if the sheet already
// has that literal combined phrase, per the guideline's "if the sheet
// already has a combined phrase, treat it as one segment" rule.
//
// All 2-way candidates are checked in ONE request each for categories/brands
// via an OR'd WHERE clause (matchAnyExactCategories/matchAnyExactBrands),
// NOT one request per candidate — an early version fired one parallel
// request per candidate, and for a longer hashtag with a dozen-plus
// candidates (times two hashtags running concurrently) that was enough
// simultaneous traffic to make Google's gviz endpoint start timing out
// entirely, including for ordinary single-term lookups running at the same
// time. Deliberately 2-way only (no 3-way/two-space search): that
// combination count grows quadratically with hashtag length and was the
// biggest source of that request burst, and a genuine 3+-word combined
// phrase is something the AI research step recognizes immediately on its
// own anyway (it's a trivial word-segmentation call for a language model —
// see the "does the AI need search to see this" discussion), so skipping it
// here only means a few extra hashtags go to research instead of matching
// for free, not that they get misclassified.
async function tryMatchCombinedPhrase(segment) {
  const n = segment.length;
  const candidates = [];
  for (let i = MIN_PART_LENGTH; i <= n - MIN_PART_LENGTH; i++) {
    candidates.push(`${segment.slice(0, i)} ${segment.slice(i)}`);
  }
  if (candidates.length === 0) return null;

  const [catResult, brandResult] = await Promise.all([
    matchAnyExactCategories(candidates),
    matchAnyExactBrands(candidates),
  ]);

  if (catResult.status === "ok" && catResult.rows.length > 0) {
    // Column E (cat5, index 4) of any returned row must be one of our
    // candidate phrases — that's the only thing the OR clause could have
    // matched on. Group by that value in case more than one row shares it
    // (e.g. the same cat5 value appearing under more than one cat1/2/3 path).
    const matchedPhrase = catResult.rows[0][4];
    const rows = catResult.rows.filter((r) => r[4] === matchedPhrase);
    return { phrase: matchedPhrase, matches: preferMainVertical(rows.map(rowToPath)), isBrand: false };
  }
  if (brandResult.status === "ok" && brandResult.rows.length > 0) {
    const matchedPhrase = brandResult.rows[0][0]; // column A of the brands tab
    const rows = brandResult.rows.filter((r) => r[0] === matchedPhrase);
    return {
      phrase: matchedPhrase,
      matches: rows.map(([brand, productLine]) => ({ brand, productLine })),
      isBrand: true,
    };
  }
  return null;
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
const COMPOUND_SPLIT_BUDGET_MS = 20000;

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

// Step 3.7's helper: checks whether the segment matches an existing cat4,
// cat3, or cat2 value directly (columns D, C, B), stopping at the first
// (deepest) level found. Multiple sheet rows can share the same cat1..depth
// path with different deeper values (e.g. many cat5 children under one
// cat4) — once we know only THIS level is confirmed, everything deeper than
// it is blanked out and duplicate paths are de-duped.
async function tryMatchPartialLevel(segment) {
  for (const [column, depth] of [
    ["D", 4],
    ["C", 3],
    ["B", 2],
  ]) {
    const res = await matchCategoryColumn(column, segment);
    if (res.status !== "ok" || res.rows.length === 0) continue;

    const seen = new Set();
    const matches = [];
    for (const row of res.rows) {
      const path = rowToPath(row);
      path.cat5 = "";
      if (depth < 4) path.cat4 = "";
      const key = `${path.cat1}|${path.cat2}|${path.cat3}|${path.cat4}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(path);
    }
    return { depth, matches: preferMainVertical(matches) };
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

  // Step 1: exact match.
  const exact = await exactMatchCategories(segment);
  if (exact.status === "error") {
    return { status: "error", segment: rawSegment, error: exact.error, notes };
  }
  if (exact.rows.length > 0) {
    return {
      status: "exact",
      segment: rawSegment,
      matches: preferMainVertical(exact.rows.map(rowToPath)),
      notes,
    };
  }

  // Step 1b: also check brands tab for an exact literal brand match.
  const brandExact = await exactMatchBrands(segment);
  if (brandExact.status === "error") {
    return { status: "error", segment: rawSegment, error: brandExact.error, notes };
  }
  if (brandExact.rows.length > 0) {
    return {
      status: "exact_brand",
      segment: rawSegment,
      matches: brandExact.rows.map(([brand, productLine]) => ({ brand, productLine })),
      notes,
    };
  }

  // Step 1c: try inserting a space at each plausible point and see if the
  // sheet already has that combined phrase (see tryMatchCombinedPhrase above
  // for why this comes before both stemming/abbreviation and the
  // independent-word compound split below).
  const combined = await tryMatchCombinedPhrase(segment);
  if (combined) {
    notes.push(`matched as combined phrase "${combined.phrase}"`);
    return combined.isBrand
      ? {
          status: "exact_brand",
          segment: rawSegment,
          matches: combined.matches,
          notes,
        }
      : {
          status: "exact",
          segment: rawSegment,
          matches: combined.matches,
          notes,
        };
  }

  // Step 2: strip common word-form endings and retry.
  for (const variant of stemVariants(segment)) {
    const res = await exactMatchCategories(variant);
    if (res.status === "error") {
      notes.push(`stem variant "${variant}" query failed: ${res.error}`);
      continue;
    }
    if (res.rows.length > 0) {
      notes.push(`matched via stemmed form "${variant}"`);
      return {
        status: "stemmed",
        segment: rawSegment,
        matches: preferMainVertical(res.rows.map(rowToPath)),
        notes,
      };
    }
  }

  // Step 3: expand known abbreviations and retry.
  const expanded = expandAbbreviation(segment);
  if (expanded) {
    const res = await exactMatchCategories(expanded);
    if (res.status === "error") {
      return { status: "error", segment: rawSegment, error: res.error, notes };
    }
    if (res.rows.length > 0) {
      notes.push(`expanded abbreviation "${segment}" -> "${expanded}"`);
      return {
        status: "abbreviation",
        segment: rawSegment,
        matches: preferMainVertical(res.rows.map(rowToPath)),
        notes,
      };
    }
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

  // Step 3.7: classification doesn't always need to reach cat5 — a bare word
  // that matches an existing cat2/cat3/cat4 value directly (e.g. "nails",
  // "skincare") is a complete, valid result on its own, per the guideline's
  // "stop at whatever level you've confidently reached, don't exclude" rule
  // (e.g. #vancouvernails -> vancouver + [beauty, nails, "", "", ""], stopping
  // at cat2 "nails"). Only tried after every attempt at a full cat5-level
  // match (literal, combined phrase, stemmed, abbreviation, compound-split)
  // has failed — a deeper existing match is always preferred over stopping
  // early. Checked from cat4 down to cat2 so the most specific level that
  // actually exists wins.
  const partial = await tryMatchPartialLevel(segment);
  if (partial) {
    notes.push(`matched at cat${partial.depth} level only — no more specific cat5 exists for this literal word`);
    return { status: "partial", segment: rawSegment, matches: partial.matches, notes };
  }

  // Nothing matched — hand off to step 4 (research).
  return { status: "needs_research", segment: rawSegment, notes };
}
