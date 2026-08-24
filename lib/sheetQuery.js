// Thin wrapper around the Google Sheets gviz CSV endpoint.
// This endpoint is read-only by construction (we only ever build "select"
// queries) — we never write back to the sheet.

const SHEET_ID = process.env.SHEET_ID;

function gvizUrl(tab, tq) {
  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`;
  const params = new URLSearchParams({ sheet: tab, tq, tqx: "out:csv" });
  return `${base}?${params.toString()}`;
}

// Minimal CSV parser sufficient for gviz's quoted-CSV output.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

// Result status is explicit so callers never confuse "query failed" with
// "query succeeded, zero matches" — see the app's error-handling design note.
//
// Free-tier matching (matcher.js) makes many of these calls per hashtag with
// no timeout of its own — unlike the AI research step (which has its own
// hard 2-min-per-hashtag budget, see claudeResearch.js's RESEARCH_DEADLINE_MS),
// a bare fetch() has no default timeout at all, so a single hung request to
// Google's gviz endpoint could otherwise stall a hashtag indefinitely with no
// safety net. Capping each attempt here closes that gap.
const GVIZ_TIMEOUT_MS = 15000;

export async function runGvizQuery(tab, tq, { retries = 2 } = {}) {
  const url = gvizUrl(tab, tq);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GVIZ_TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!res.ok) {
        lastError = new Error(`Sheet query failed with status ${res.status}`);
        continue;
      }
      const text = await res.text();
      // gviz's "select * where ..." responses never include a header row
      // (verified against the live sheet) — every row here is real data.
      const rows = parseCsv(text);
      return { status: "ok", rows };
    } catch (err) {
      lastError = err?.name === "AbortError" ? new Error(`Sheet query timed out after ${GVIZ_TIMEOUT_MS / 1000}s`) : err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return { status: "error", error: lastError?.message || "unknown error", rows: [] };
}

function escapeForQuery(value) {
  return value.replace(/'/g, "\\'");
}

export async function exactMatchCategories(term) {
  const tab = process.env.CATEGORIES_TAB || "categories";
  const tq = `select * where E = '${escapeForQuery(term)}'`;
  return runGvizQuery(tab, tq);
}

// Same idea as exactMatchCategories, but against an arbitrary categories-tab
// column — used to check whether a segment matches at the cat2/cat3/cat4
// level directly (columns B/C/D) when there's no cat5-level (column E) match
// for it. Classification doesn't always need to reach cat5 — a bare word
// that matches an existing cat2/cat3/cat4 value is a complete, valid result
// on its own (see the guideline's "stop at whatever level you've confidently
// reached" rule).
export async function matchCategoryColumn(column, term) {
  const tab = process.env.CATEGORIES_TAB || "categories";
  const tq = `select * where ${column} = '${escapeForQuery(term)}'`;
  return runGvizQuery(tab, tq);
}

export async function exactMatchBrands(term) {
  const tab = process.env.BRANDS_TAB || "brands";
  const tq = `select * where A = '${escapeForQuery(term)}'`;
  return runGvizQuery(tab, tq);
}

// Checks many literal candidate values in ONE request via an OR'd WHERE
// clause, instead of one request per candidate. Used by matcher.js's
// combined-phrase step, which can generate a dozen-plus candidate phrases
// for a single hashtag (one per plausible space position) — firing those as
// separate parallel requests previously caused a burst of simultaneous
// traffic against Google's gviz endpoint large enough to make it start
// timing out, including for ordinary single-term lookups running at the same
// time. Folding them into one query keeps this at the same request cost as
// a normal lookup regardless of how many candidates there are.
export async function matchAnyExactCategories(terms) {
  if (terms.length === 0) return { status: "ok", rows: [] };
  const tab = process.env.CATEGORIES_TAB || "categories";
  const clause = terms.map((t) => `E = '${escapeForQuery(t)}'`).join(" or ");
  const tq = `select * where ${clause}`;
  return runGvizQuery(tab, tq);
}

export async function matchAnyExactBrands(terms) {
  if (terms.length === 0) return { status: "ok", rows: [] };
  const tab = process.env.BRANDS_TAB || "brands";
  const clause = terms.map((t) => `A = '${escapeForQuery(t)}'`).join(" or ");
  const tq = `select * where ${clause}`;
  return runGvizQuery(tab, tq);
}

// Cached separately (see lib/cat123Cache.js) — this fetches all A/B/C values
// and de-dupes client-side (gviz's "group by" rejects grouping by every
// selected column at once, so we can't push the dedup into the query itself).
export async function fetchCat123Tree() {
  const tab = process.env.CATEGORIES_TAB || "categories";
  const tq = `select A, B, C`;
  const result = await runGvizQuery(tab, tq);
  if (result.status !== "ok") return result;

  const seen = new Set();
  const unique = [];
  for (const row of result.rows) {
    const key = row.join("");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(row);
    }
  }
  return { status: "ok", rows: unique };
}
