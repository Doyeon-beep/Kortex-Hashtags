// Converts /api/classify results into rows matching the established header:
// cat1, cat2, cat3, cat4, cat5, brand, product line, hashtag, inclusion, new, comments

export const HEADER = [
  "cat1",
  "cat2",
  "cat3",
  "cat4",
  "cat5",
  "brand",
  "product line",
  "hashtag",
  "inclusion",
  "new",
  "comments",
];

function baseComment(r) {
  const parts = [...(r.notes || [])];
  if (r.inconsistent) parts.push("⚠ Consistency check needed - same segment classified differently in this batch");
  return parts.join("; ");
}

// One AI research entry -> one row. A single "needs_research" segment can
// resolve to MULTIPLE entries when it's really several existing concepts
// stuck together (e.g. "koreanbeauty" -> "korean" + bare "beauty"), so this
// is applied per-entry rather than once per segment.
function researchEntryToRow(entry, hashtag, baseReasoning) {
  const flagSuffix = entry.needs_human_review ? " (needs human review)" : "";
  const reasoning = [baseReasoning, (entry.reasoning || "") + flagSuffix].filter(Boolean).join("; ");

  if (entry.is_out_of_scope) {
    return ["tiktok_exclusions", "", "", "", "", "", "", hashtag, "exclude", "", reasoning];
  }

  // stop_at_partial_level exists ONLY for when there's genuinely nothing to
  // put at cat5 (bare "nails", "feminine care", etc — see the guideline's
  // "stop at whatever level reached" rule). If the model also gave us an
  // actual value, that means it identified a real cat5/brand/product-line
  // match despite the flag — use it. Discarding a known-correct value here
  // (e.g. AI reasoning explicitly said "this is bad girls club" but the row
  // still came out with cat5 blank) was a real bug, not the model's fault.
  const hasValue = typeof entry.value === "string" && entry.value.trim() !== "";
  if (entry.stop_at_partial_level && !hasValue) {
    return [entry.cat1 || "", entry.cat2 || "", entry.cat3 || "", entry.cat4 || "", "", "", "", hashtag, "include", "", reasoning];
  }

  const isBrand = entry.value_type === "brand";
  const isProductLine = entry.value_type === "product_line";
  const newLabel = entry.is_new
    ? entry.value_type === "cat5"
      ? "cat5"
      : entry.value_type === "brand"
      ? "brand"
      : entry.value_type === "product_line"
      ? "product line"
      : ""
    : "";

  return [
    entry.cat1 || "",
    entry.cat2 || "",
    entry.cat3 || "",
    entry.cat4 || "",
    isBrand || isProductLine ? "" : entry.value || "",
    isBrand ? entry.value : "",
    isProductLine ? entry.value : "",
    hashtag,
    "include",
    newLabel,
    reasoning,
  ];
}

export function resultsToRows(results) {
  const rows = [];

  for (const r of results) {
    const comment = baseComment(r);

    if (r.status === "exact" || r.status === "stemmed" || r.status === "abbreviation" || r.status === "segmented") {
      for (const m of r.matches) {
        rows.push([m.cat1, m.cat2, m.cat3, m.cat4, m.cat5, "", "", r.hashtag, "include", "", comment]);
      }
      continue;
    }

    if (r.status === "exact_brand") {
      for (const m of r.matches) {
        rows.push([
          "",
          "",
          "",
          "",
          "",
          m.brand,
          m.productLine || "",
          r.hashtag,
          "include",
          "",
          [comment, "Brand matched only - please confirm product type (cat5)"].filter(Boolean).join("; "),
        ]);
      }
      continue;
    }

    if (r.status === "error") {
      rows.push(["", "", "", "", "", "", "", r.hashtag, "", "", `Lookup failed - please retry: ${r.error}`]);
      continue;
    }

    if (r.status === "needs_research") {
      const research = r.research;
      if (!research) {
        rows.push(["", "", "", "", "", "", "", r.hashtag, "", "", "Needs AI review (not run - useResearch option was off)"]);
        continue;
      }

      const entries = Array.isArray(research.entries) ? research.entries : [research];
      for (const entry of entries) {
        rows.push(researchEntryToRow(entry, r.hashtag, comment));
      }
      continue;
    }

    // Fallback — shouldn't normally happen.
    rows.push(["", "", "", "", "", "", "", r.hashtag, "", "", `Unknown status: ${r.status}`]);
  }

  return rows;
}
