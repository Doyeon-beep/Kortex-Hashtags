// Very small, deliberately conservative suffix-stripping helper.
// English-only — non-English segments should go through translation before
// reaching this step (see lib/translate.js).
export function stemVariants(word) {
  const w = word.trim().toLowerCase();
  const variants = new Set();

  if (w.endsWith("ies") && w.length > 4) variants.add(w.slice(0, -3) + "y"); // babies -> baby
  if (w.endsWith("es") && w.length > 3) variants.add(w.slice(0, -2)); // boxes -> box
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) variants.add(w.slice(0, -1)); // cakes -> cake
  if (w.endsWith("ing") && w.length > 5) {
    const base = w.slice(0, -3);
    variants.add(base); // loving -> lov (needs the +e case below too)
    variants.add(base + "e"); // lov -> love
  }
  if (w.endsWith("ed") && w.length > 4) {
    const base = w.slice(0, -2);
    variants.add(base);
    variants.add(base + "e");
  }

  variants.delete(w);
  return Array.from(variants);
}
