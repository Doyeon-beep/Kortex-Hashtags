// Post-batch reconciliation pass (task #9 / concern #1 from the design
// discussion): sheet lookups (steps 1-3) are deterministic, so they can't
// disagree with themselves — but the AI research step (step 4) is NOT
// deterministic, so the same or a near-identical segment appearing in two
// different hashtags in the same batch could get two different answers.
// This doesn't auto-fix anything; it just flags the disagreement so a human
// can reconcile it before the batch is finalized, per the guideline's
// "한 배치 안에서 같은 개념을 일관되게 처리한다" rule.

function resultKey(result) {
  if (result.matches) {
    return JSON.stringify(result.matches);
  }
  if (result.research) {
    // researchNewEntity() returns { status, entries: [...] } — the comparable
    // classification fields live on each entry, not on this top-level
    // object. Reading r.cat1/r.value/r.is_new directly here (as this used to)
    // always read undefined, so every AI-research result produced the exact
    // same key regardless of its actual content — the inconsistency check
    // was silently a no-op for every AI-researched hashtag, only ever
    // catching disagreements between deterministic sheet-matched results.
    const entries = Array.isArray(result.research.entries) ? result.research.entries : [];
    return JSON.stringify(
      entries.map((e) => ({
        cat1: e.cat1,
        cat2: e.cat2,
        cat3: e.cat3,
        cat4: e.cat4,
        cat5: e.cat5,
        brand: e.brand,
        product_line: e.product_line,
      }))
    );
  }
  return null;
}

export function reconcileConsistency(results) {
  const groups = new Map(); // normalized segment -> [{hashtag, key}]

  for (const r of results) {
    const key = resultKey(r);
    if (!key) continue;
    const normalized = (r.segment || "").trim().toLowerCase();
    if (!groups.has(normalized)) groups.set(normalized, []);
    groups.get(normalized).push({ hashtag: r.hashtag, key });
  }

  const flags = [];
  for (const [segment, entries] of groups) {
    const distinctKeys = new Set(entries.map((e) => e.key));
    if (distinctKeys.size > 1) {
      flags.push({
        segment,
        hashtags: entries.map((e) => e.hashtag),
        message: `Segment "${segment}" was classified differently within this batch — please review.`,
      });
    }
  }

  // Attach the flag onto each affected result so the UI can highlight it
  // inline, in addition to the batch-level summary list.
  const flaggedSegments = new Set(flags.map((f) => f.segment));
  const annotated = results.map((r) => {
    const normalized = (r.segment || "").trim().toLowerCase();
    return flaggedSegments.has(normalized) ? { ...r, inconsistent: true } : r;
  });

  return { results: annotated, flags };
}
