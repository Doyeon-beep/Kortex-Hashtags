import { NextResponse } from "next/server";
import { sql, parseJsonColumn } from "../../../lib/db";

// cat1..comments, in the same order as batches.original_rows / batch_rows'
// current columns (excluding hashtag, which never changes on a correction).
const DIFF_FIELDS = [
  { index: 0, column: "cat1", label: "cat1" },
  { index: 1, column: "cat2", label: "cat2" },
  { index: 2, column: "cat3", label: "cat3" },
  { index: 3, column: "cat4", label: "cat4" },
  { index: 4, column: "cat5", label: "cat5" },
  { index: 5, column: "brand", label: "brand" },
  { index: 6, column: "product_line", label: "product line" },
  { index: 8, column: "inclusion", label: "inclusion" },
  { index: 9, column: "new_label", label: "new" },
];

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const reviewer = searchParams.get("reviewer");

  try {
    const totalsRows = reviewer
      ? await sql`
          select count(r.id)::int as total_rows, count(r.id) filter (where r.edited)::int as total_mistakes
          from batch_rows r join batches b on b.id = r.batch_id
          where b.created_by = ${reviewer}
        `
      : await sql`
          select count(r.id)::int as total_rows, count(r.id) filter (where r.edited)::int as total_mistakes
          from batch_rows r join batches b on b.id = r.batch_id
        `;
    const totals = totalsRows[0] || { total_rows: 0, total_mistakes: 0 };
    const accuracyPct =
      totals.total_rows > 0 ? Math.round(((totals.total_rows - totals.total_mistakes) / totals.total_rows) * 100) : null;

    const tagDistribution = reviewer
      ? await sql`
          select r.mistake_tag as tag, count(*)::int as count
          from batch_rows r join batches b on b.id = r.batch_id
          where r.mistake_tag is not null and b.created_by = ${reviewer}
          group by r.mistake_tag
          order by count desc
        `
      : await sql`
          select r.mistake_tag as tag, count(*)::int as count
          from batch_rows r join batches b on b.id = r.batch_id
          where r.mistake_tag is not null
          group by r.mistake_tag
          order by count desc
        `;

    const byReviewer = await sql`
      select b.created_by as reviewer, count(r.id)::int as rows, count(r.id) filter (where r.edited)::int as mistakes
      from batches b join batch_rows r on r.batch_id = b.id
      group by b.created_by
      order by rows desc
    `;

    const logRowsRaw = reviewer
      ? await sql`
          select r.id, r.row_index, r.hashtag, r.mistake_tag, r.cat1, r.cat2, r.cat3, r.cat4, r.cat5,
                 r.brand, r.product_line, r.inclusion, r.new_label,
                 b.created_by as reviewer, b.original_rows
          from batch_rows r join batches b on b.id = r.batch_id
          where r.mistake_tag is not null and b.created_by = ${reviewer}
          order by r.id desc
          limit 200
        `
      : await sql`
          select r.id, r.row_index, r.hashtag, r.mistake_tag, r.cat1, r.cat2, r.cat3, r.cat4, r.cat5,
                 r.brand, r.product_line, r.inclusion, r.new_label,
                 b.created_by as reviewer, b.original_rows
          from batch_rows r join batches b on b.id = r.batch_id
          where r.mistake_tag is not null
          order by r.id desc
          limit 200
        `;

    const mistakeLog = logRowsRaw.map((row) => {
      const originalRows = parseJsonColumn(row.original_rows, []);
      const original = originalRows[row.row_index] || [];
      const current = [
        row.cat1,
        row.cat2,
        row.cat3,
        row.cat4,
        row.cat5,
        row.brand,
        row.product_line,
        row.hashtag,
        row.inclusion,
        row.new_label,
      ];
      const changes = DIFF_FIELDS.filter((f) => (original[f.index] || "") !== (current[f.index] || "")).map((f) => ({
        field: f.label,
        from: original[f.index] || "",
        to: current[f.index] || "",
      }));
      const originalClassification = {
        cat1: original[0] || "",
        cat2: original[1] || "",
        cat3: original[2] || "",
        cat4: original[3] || "",
        cat5: original[4] || "",
        brand: original[5] || "",
        productLine: original[6] || "",
        inclusion: original[8] || "",
      };
      const currentClassification = {
        cat1: current[0] || "",
        cat2: current[1] || "",
        cat3: current[2] || "",
        cat4: current[3] || "",
        cat5: current[4] || "",
        brand: current[5] || "",
        productLine: current[6] || "",
        inclusion: current[8] || "",
      };
      return {
        id: row.id,
        hashtag: row.hashtag,
        tag: row.mistake_tag,
        reviewer: row.reviewer,
        changes,
        originalClassification,
        currentClassification,
      };
    });

    return NextResponse.json({
      summary: { totalRows: totals.total_rows, totalMistakes: totals.total_mistakes, accuracyPct },
      tagDistribution,
      byReviewer: byReviewer.map((r) => ({
        reviewer: r.reviewer,
        rows: r.rows,
        mistakes: r.mistakes,
        accuracy: r.rows > 0 ? Math.round(((r.rows - r.mistakes) / r.rows) * 100) : null,
      })),
      mistakeLog,
    });
  } catch (err) {
    console.error("[quality] failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
