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
    const r = result.research;
    return JSON.stringify({
      cat1: r.cat1,
      cat2: r.cat2,
      cat3: r.cat3,
      cat4: r.cat4,
      value: r.value,
      is_new: r.is_new,
    });
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
