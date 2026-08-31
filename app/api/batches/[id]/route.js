import { NextResponse } from "next/server";
import { sql } from "../../../../lib/db";

// Full batch detail (all rows, in order) - used by History's "View" action.
export async function GET(request, { params }) {
  try {
    const [batch] = await sql`select id, created_at, created_by, name, hashtag_count, flags from batches where id = ${params.id}`;
    if (!batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }
    const rows = await sql`
      select cat1, cat2, cat3, cat4, cat5, brand, product_line, hashtag, inclusion, new_label, comments, edited
      from batch_rows
      where batch_id = ${params.id}
      order by row_index
    `;
    return NextResponse.json({ batch, rows });
  } catch (err) {
    console.error("[batches] get failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Partial update - rename the batch and/or resave its rows after an edit.
// Rows are replaced wholesale (delete + reinsert) rather than diffed cell by
// cell; batches are small (tens to a couple hundred rows), so this is simple
// and fast enough, and avoids needing to track per-cell identity.
export async function PATCH(request, { params }) {
  const body = await request.json();

  try {
    if (typeof body.name === "string") {
      await sql`update batches set name = ${body.name} where id = ${params.id}`;
    }

    if (Array.isArray(body.rows)) {
      const editedFlags = Array.isArray(body.editedFlags) ? body.editedFlags : [];
      await sql`delete from batch_rows where batch_id = ${params.id}`;
      if (body.rows.length > 0) {
        const rowRecords = body.rows.map((r, i) => ({
          batch_id: params.id,
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
          edited: Boolean(editedFlags[i]),
        }));
        await sql`insert into batch_rows ${sql(rowRecords)}`;
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[batches] update failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    await sql`delete from batches where id = ${params.id}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[batches] delete failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
