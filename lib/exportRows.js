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
  "mistake type",
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
  // cat5, brand, and product_line are independent fields now (see
  // claudeResearch.js's entrySchema) — an entry can fill any combination of
  // them at once (e.g. a manufacturer brand that's newly proposed alongside
  // an existing cat5 match). The older schema had one shared "value"/
  // "value_type" slot for all three, so an entry could only ever report ONE
  // of them even when the model's own reasoning clearly identified more than
  // one — that silent drop was a real bug, not the model's fault.
  const newFields = Array.isArray(entry.new_fields) ? entry.new_fields : [];
  const newLabel = newFields.map((f) => (f === "product_line" ? "product line" : f)).join(", ");

  // A needs_human_review entry with nothing else filled in (a research
  // failure/timeout/abort, not a real-but-uncertain classification) hasn't
  // actually decided include vs exclude - marking it "include" anyway is
  // misleading, since that's exactly the piece of information that's
  // missing. Leave it blank so it reads as genuinely undetermined, distinct
  // from a real (if flagged) classification that DID reach a conclusion.
  const hasAnyClassification = Boolean(entry.cat1 || entry.cat5 || entry.brand || entry.product_line);
  const inclusion = entry.needs_human_review && !hasAnyClassification ? "" : "include";

  // For a bare failure/timeout/abort (no classification at all), lead with
  // a clean "NEEDS HUMAN REVIEW" flag followed by the actual reason (e.g.
  // "exceeded its 39s time budget" vs "Request was aborted") - distinguishing
  // "ran out of time before finishing research" from "researched but still
  // couldn't conclude" matters when deciding whether to just retry. The
  // fallback reasoning strings already end with their own "— needs human
  // review" - strip that off first so it doesn't repeat right after the flag.
  const rawReasoning =
    entry.needs_human_review && !hasAnyClassification
      ? ["NEEDS HUMAN REVIEW", (entry.reasoning || "").replace(/[\s—-]*needs human review\.?\s*$/i, "").trim()]
          .filter(Boolean)
          .join(" — ")
      : [baseReasoning, entry.reasoning, entry.needs_human_review ? "(needs human review)" : ""]
          .filter(Boolean)
          .join("; ");

  // The guideline requires every entry to explain itself (and the schema
  // now enforces reasoning can't be an empty string), but this is a defensive
  // backstop: if a classified entry's reasoning ever comes through blank
  // anyway, don't let the comment go silently empty. That silence is exactly
  // how a stray, mostly-empty entry the model shouldn't have submitted at all
  // (e.g. a modifier fragment mistakenly treated as its own concept) went
  // unnoticed before.
  const reasoning = rawReasoning || (hasAnyClassification ? "(no explanation provided by AI)" : "");

  if (entry.is_out_of_scope) {
    return ["tiktok_exclusions", "", "", "", "", "", "", hashtag, "exclude", "", reasoning];
  }

  return [
    entry.cat1 || "",
    entry.cat2 || "",
    entry.cat3 || "",
    entry.cat4 || "",
    entry.cat5 || "",
    entry.brand || "",
    entry.product_line || "",
    hashtag,
    inclusion,
    newLabel,
    reasoning,
  ];
}

export function resultsToRows(results) {
  const rows = [];

  for (const r of results) {
    const comment = baseComment(r);

    if (
      r.status === "exact" ||
      r.status === "stemmed" ||
      r.status === "abbreviation" ||
      r.status === "segmented" ||
      r.status === "partial"
    ) {
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

    if (r.status === "invalid_format") {
      rows.push([
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        r.hashtag,
        "",
        "",
        "Invalid hashtag - must start with exactly one # and contain no commas or periods",
      ]);
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

  // "mistake type" starts blank on every row - it's filled in by a reviewer
  // (see page.js's mistake-tag dropdown), never by the classifier itself.
  return rows.map((r) => [...r, ""]);
}
