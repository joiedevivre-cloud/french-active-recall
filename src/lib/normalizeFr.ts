// Mirrors the server-side generated column expressions.expression_fr_normalized
// (public.immutable_unaccent(lower(btrim(expression_fr))), see
// supabase/migrations/0001_core_schema.sql) closely enough for client-side
// duplicate lookups: trim, lowercase, strip combining diacritical marks
// produced by NFD decomposition of accented Latin letters (e.g. e-acute ->
// plain "e" + a combining acute accent mark).
//
// Combining Diacritical Marks occupy code points 0x0300-0x036F. Filtering by
// numeric code point (rather than a regex literal containing those
// characters) keeps this file plain ASCII source.
const COMBINING_MARKS_START = 0x0300;
const COMBINING_MARKS_END = 0x036f;

export function normalizeFr(text: string): string {
  const decomposed = text.trim().toLowerCase().normalize('NFD');
  let result = '';
  for (const char of decomposed) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= COMBINING_MARKS_START && codePoint <= COMBINING_MARKS_END) continue;
    result += char;
  }
  return result;
}
