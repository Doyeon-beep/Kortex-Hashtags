import { fetchCat123Tree } from "./sheetQuery";

// In-memory, best-effort cache of the cat1/cat2/cat3 skeleton.
// NOTE: on Vercel serverless, each cold-started instance starts with an
// empty cache, so this is a "best effort, saves repeat calls within a warm
// instance" cache rather than a guaranteed persistent one. That's fine here —
// it only exists to cut down on broad sheet queries; cat4/cat5 (where real
// volatility lives) are still always queried live, per the guideline.
const TTL_MS = 24 * 60 * 60 * 1000; // refresh at most once a day

let cache = { tree: null, fetchedAt: 0 };

export async function getCat123Tree() {
  const isFresh = cache.tree && Date.now() - cache.fetchedAt < TTL_MS;
  if (isFresh) return cache.tree;

  const result = await fetchCat123Tree();
  if (result.status !== "ok") {
    // Query failed — serve stale cache if we have one rather than pretending
    // the tree is empty.
    if (cache.tree) return cache.tree;
    return [];
  }

  cache = { tree: result.rows, fetchedAt: Date.now() };
  return cache.tree;
}
