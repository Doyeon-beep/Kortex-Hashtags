// The taxonomy sheet's own cat1-cat5 values are always English strings, so
// non-English segments (Korean, Japanese, Spanish, French, etc. — all
// in-scope per the guideline's Language Scope section) need to be translated
// to English BEFORE exact-match/stem lookups, otherwise they'll never match.

const NON_LATIN_RANGE =
  /[぀-ヿ㐀-鿿가-힣Ѐ-ӿ]/; // kana/kanji/hangul/cyrillic

export function looksNonEnglish(segment) {
  return NON_LATIN_RANGE.test(segment);
}

// Returns { translated: string|null, skipped: boolean }.
// If no translation API key is configured, translation is skipped and the
// segment falls through to the step-4 research stage instead of silently
// mismatching.
export async function translateToEnglish(segment) {
  const apiKey = process.env.TRANSLATE_API_KEY;
  if (!apiKey) {
    return { translated: null, skipped: true };
  }

  try {
    const res = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: segment, target: "en", format: "text" }),
      }
    );
    if (!res.ok) return { translated: null, skipped: true };
    const data = await res.json();
    const text = data?.data?.translations?.[0]?.translatedText;
    return { translated: text || null, skipped: !text };
  } catch {
    return { translated: null, skipped: true };
  }
}
