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

const COLUMN_INDEX = { A: 0, B: 1, C: 2, D: 3, E: 4 };

// Shared by both the whole-segment check (matchAllFreeCandidates) and each
// split-off word (candidateTermsForWord below) - inserting a space turns a
// hashtag-glued compound into the multi-word phrase form the sheet actually
// stores cat5 values as (hashtags can never contain spaces themselves). Also
// tries simple pluralization of the trailing word, for the same "free, no AI
// needed" reason as matchAllFreeCandidates's original version of this logic.
function spaceInsertedPhrases(text) {
  const n = text.length;
  const phrases = [];
  for (let i = MIN_PART_LENGTH; i <= n - MIN_PART_LENGTH; i++) {
    const left = text.slice(0, i);
    const right = text.slice(i);
    phrases.push(`${left} ${right}`);
    if (!/s$/.test(right)) {
      phrases.push(`${left} ${right}s`);
      if (/[sxz]$|[cs]h$/.test(right)) {
        phrases.push(`${left} ${right}es`);
      }
    }
  }
  return phrases;
}

// Ordered candidate cat5 (column E) terms for a single literal word, exactly
// mirroring the priority matchSegment() itself uses: literal word first,
// then stem variants, then the abbreviation expansion, then (for a long
// enough word) space-inserted variants of ITSELF.
//
// That last part matters because a "word" here isn't always a true atomic
// word - trySegmentCompound hands this whichever half/third a split point
// produced, and that piece can itself be a glued-together compound. Real
// error: splitting "napleshairstylist" into ["naples", "hairstylist"] used
// to fail here because "hairstylist" (no space) doesn't match anything on
// its own - which meant this 2-way split was rejected, and a worse 3-way
// split ["naples", "hair", "stylist"] won instead, tearing the existing
// compound cat5 "hair stylist" into two unrelated, wrong independent
// matches ("hair" the body part, "stylist" the generic role). Checking
// "hairstylist" for its own space-inserted variants ("hair stylist" among
// them) lets the correct 2-way split succeed on its own terms, which is
// tried before any 3-way split per trySegmentCompound's priority order.
function candidateTermsForWord(word) {
  const stems = stemVariants(word);
  const expanded = expandAbbreviation(word);
  const innerPhrases = word.length >= MIN_PART_LENGTH * 2 ? spaceInsertedPhrases(word) : [];
  return [word, ...stems, ...(expanded ? [expanded] : []), ...innerPhrases];
}

// Resolves many independent words against the categories tab in ONE request,
// instead of a separate exact+stem+abbreviation lookup (itself several
// queries) per word. Used by trySegmentCompound below, which needs to check
// dozens of candidate split halves/thirds for a long hashtag — checking them
// one split point at a time in sequence was the reason a hashtag whose
// correct split happens to be a later split point (e.g. "haircuttools" ->
// "haircut"+"tools" is the 5th of 7 possible 2-way split points) could run
// out of its search budget before ever reaching it, even though both halves
// genuinely exist in the sheet. Batching means every split point gets
// checked, not just however many fit before the clock runs out.
async function resolveWordsAgainstSheet(words) {
  const perWordTerms = new Map();
  const allTerms = new Set();
  for (const w of words) {
    const terms = candidateTermsForWord(w);
    perWordTerms.set(w, terms);
    terms.forEach((t) => allTerms.add(t));
  }

  const result = await matchAnyInCategories(Array.from(allTerms).map((value) => ({ column: "E", value })));
  if (result.status === "error") return { status: "error", error: result.error };

  const rowsByTerm = new Map();
  for (const row of result.rows) {
    const term = row[COLUMN_INDEX.E];
    if (!rowsByTerm.has(term)) rowsByTerm.set(term, []);
    rowsByTerm.get(term).push(row);
  }

  const resolved = new Map();
  for (const w of words) {
    let found = null;
    for (const term of perWordTerms.get(w)) {
      const rows = rowsByTerm.get(term);
      if (rows && rows.length > 0) {
        found = { status: "ok", matches: preferMainVertical(rows.map(rowToPath)) };
        break;
      }
    }
    resolved.set(w, found || { status: "none" });
  }
  return { status: "ok", resolved };
}

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
// research, even after capping the worst single offender (the independent-
// word compound-split search, since batched below). Since every one of
// these checks is really just
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
  const combinedPhrases = spaceInsertedPhrases(segment);
  // A hashtag can contain a literal hyphen (hashtags can never contain
  // periods/commas, but hyphens are allowed) - the sheet may store the
  // matching cat5 with or without one regardless of which form the hashtag
  // happens to use, so check both in the same request. Real error:
  // "pre-shower makeup" (hyphenated) was proposed as new when the sheet
  // already had it without the hyphen.
  const hyphenVariant = segment.includes("-")
    ? segment.replace(/-/g, " ")
    : segment.includes(" ")
    ? segment.replace(" ", "-")
    : null;

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
    ...(hyphenVariant
      ? [
          {
            source: "cat",
            column: "E",
            value: hyphenVariant,
            statusLabel: "exact",
            note: `matched via hyphen/space variant "${hyphenVariant}"`,
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
// segment alone is ~15 two-way + ~80 three-way combinations). This used to
// check them one split point at a time, each its own round of sheet queries,
// with a time budget that gave up once exhausted — which meant a hashtag
// whose correct split happens to be a later split point (e.g.
// "haircuttools" -> "haircut"+"tools" is the 5th of 7 possible 2-way split
// points) could run out of budget before ever trying it, even though both
// halves genuinely exist in the sheet. Now every candidate word across every
// split point is resolved together in resolveWordsAgainstSheet's single
// batched request, so which split point happens to be correct no longer
// matters for whether it gets tried.
async function trySegmentCompound(segment) {
  const n = segment.length;

  const twoWaySplits = [];
  for (let i = MIN_PART_LENGTH; i <= n - MIN_PART_LENGTH; i++) {
    twoWaySplits.push([segment.slice(0, i), segment.slice(i)]);
  }

  const threeWaySplits = [];
  if (n >= MIN_PART_LENGTH * 3) {
    for (let i = MIN_PART_LENGTH; i <= n - MIN_PART_LENGTH * 2; i++) {
      for (let j = i + MIN_PART_LENGTH; j <= n - MIN_PART_LENGTH; j++) {
        threeWaySplits.push([segment.slice(0, i), segment.slice(i, j), segment.slice(j)]);
      }
    }
  }

  // 3-way combinations grow quadratically with hashtag length - for a very
  // long hashtag that could mean hundreds of extra unique middle segments,
  // which would make the OR'd query unreasonably long. Only pull them in
  // while the 2-way words alone haven't already pushed the candidate count
  // high; past that, still try every 2-way split, just skip the 3-way sweep.
  const MAX_WORDS = 200;
  const allWords = new Set();
  for (const parts of twoWaySplits) parts.forEach((p) => allWords.add(p));
  for (const parts of threeWaySplits) {
    if (allWords.size >= MAX_WORDS) break;
    parts.forEach((p) => allWords.add(p));
  }

  const resolution = await resolveWordsAgainstSheet(Array.from(allWords));
  if (resolution.status === "error") return null;

  for (const parts of twoWaySplits) {
    const results = parts.map((p) => resolution.resolved.get(p));
    if (results.every((r) => r && r.status === "ok")) {
      return { parts, matches: results.flatMap((r) => r.matches) };
    }
  }
  for (const parts of threeWaySplits) {
    const results = parts.map((p) => resolution.resolved.get(p));
    if (results.every((r) => r && r.status === "ok")) {
      return { parts, matches: results.flatMap((r) => r.matches) };
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
