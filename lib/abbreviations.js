// Language is a fixed fact, not taxonomy data, so this dictionary is safe to
// keep in code (unlike anything read from the live Google Sheet).
// Keep growing this list whenever a new abbreviation is confirmed.
export const ABBREVIATIONS = {
  nj: "new jersey",
  ca: "california",
  fl: "florida",
  sc: "south carolina",
  tx: "texas",
  dfw: "dallas-fort worth",
  pdx: "portland",
  atl: "atlanta",
  av: "antelope valley",
  pnw: "pacific northwest",
  mua: "makeup artist",
};

export function expandAbbreviation(segment) {
  const key = segment.trim().toLowerCase();
  return ABBREVIATIONS[key] || null;
}
