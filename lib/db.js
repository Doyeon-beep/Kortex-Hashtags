// Shared Postgres connection (Supabase, via Vercel's Marketplace integration)
// backing the team-shared History / Data Quality features. Everything the
// classify pipeline itself does (matcher.js, claudeResearch.js) is completely
// independent of this — this module is only imported by the batches API
// routes, never by /api/classify, so a database outage can't break
// classification itself.
//
// A single module-level connection is reused across invocations on the same
// warm serverless instance (postgres.js pools internally), rather than
// opening a new connection per request. POSTGRES_URL is the pooled
// (pgbouncer) connection string Vercel's Supabase integration provides —
// required for serverless, since each function instance can't hold many
// direct Postgres connections open.
import postgres from "postgres";

let client = null;

export function sql(strings, ...values) {
  if (!client) {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error("POSTGRES_URL is not set - the Data Quality features need the Supabase integration configured.");
    }
    client = postgres(connectionString, { ssl: "require" });
  }
  return client(strings, ...values);
}
