import { NextResponse } from "next/server";
import { sql } from "../../../lib/db";

// List batches for the History tab. Every teammate's batches are visible by
// default (that's the whole point - a shared History instead of the old
// per-browser localStorage one) with an optional ?reviewer= filter for
// "mine only". mistake_count is derived from batch_rows.edited (a cell was
// changed at least once), matching the existing app's editedFlags concept -
// no separate per-field mistake log yet, that's a later phase.
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const reviewer = searchParams.get("reviewer");

  try {
    const batches = reviewer
      ? await sql`
          select b.id, b.created_at, b.created_by, b.name, b.hashtag_count,
                 count(r.id)::int as row_count,
                 count(r.id) filter (where r.edited)::int as mistake_count
          from batches b
          left join batch_rows r on r.batch_id = b.id
          where b.created_by = ${reviewer}
          group by b.id
          order by b.created_at desc
          limit 200
        `
      : await sql`
          select b.id, b.created_at, b.created_by, b.name, b.hashtag_count,
                 count(r.id)::int as row_count,
                 count(r.id) filter (where r.edited)::int as mistake_count
          from batches b
          left join batch_rows r on r.batch_id = b.id
          group by b.id
          order by b.created_at desc
          limit 200
        `;
    return NextResponse.json({ batches });
  } catch (err) {
    console.error("[batches] list failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Creates a batch once Classify finishes, with all its rows in one go.
export async function POST(request) {
  const body = await request.json();
  const createdBy = String(body.createdBy || "").trim();
  const name = body.name ? String(body.name) : null;
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const flags = Array.isArray(body.flags) ? body.flags : [];

  if (!createdBy) {
    return NextResponse.json({ error: "createdBy is required" }, { status: 400 });
  }

  try {
    const [batch] = await sql`
      insert into batches (created_by, name, hashtag_count, flags)
      values (${createdBy}, ${name}, ${rows.length}, ${JSON.stringify(flags)}::jsonb)
      returning id, created_at, created_by, name, hashtag_count, flags
    `;

    if (rows.length > 0) {
      const rowRecords = rows.map((r, i) => ({
        batch_id: batch.id,
        row_index: i,
        cat1: r[0] || "",
        cat2: r[1] || "",
        cat3: r[2] || "",
        cat4: r[3] || "",
        cat5: r[4] || "",
        brand: r[5] || "",
        product_line: r[6] || "",
        hashtag: r[7] || "",
        inclusion: r[8] || "",
        new_label: r[9] || "",
        comments: r[10] || "",
        edited: false,
      }));
      await sql`insert into batch_rows ${sql(rowRecords)}`;
    }

    return NextResponse.json({ batch: { ...batch, row_count: rows.length, mistake_count: 0 } });
  } catch (err) {
    console.error("[batches] create failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
