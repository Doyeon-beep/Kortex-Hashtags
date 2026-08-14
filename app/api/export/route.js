import * as XLSX from "xlsx";
import { HEADER, resultsToRows } from "../../../lib/exportRows";

export async function POST(request) {
  const body = await request.json();

  const editedRows = Array.isArray(body.rows) ? body.rows : null;
  const results = Array.isArray(body.results) ? body.results : [];

  const rows = [HEADER, ...(editedRows || resultsToRows(results))];
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = [20, 26, 24, 26, 26, 16, 18, 30, 10, 8, 60].map((w) => ({ wch: w }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "hashtag classification");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="hashtag_classification_${Date.now()}.xlsx"`,
    },
  });
}
