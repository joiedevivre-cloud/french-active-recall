import { normalizeFr } from '@/lib/normalizeFr';

/**
 * Shared search normalization for the home search and the 단어장 search:
 * case-insensitive, accent-insensitive (é = e), typographic apostrophes
 * equal to ' (’ ‘ ` ´ ʼ), whitespace collapsed. Korean text is left
 * searchable as-is (both sides get the same NFD treatment).
 */
export function normalizeSearchText(text: string | null | undefined): string {
  if (!text) return '';
  return normalizeFr(text)
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export type SearchField = string | null | undefined | (string | null | undefined)[];

/** Builds one normalized haystack from many fields (computed once per item, reused per keystroke). */
export function buildSearchText(fields: SearchField[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    if (Array.isArray(f)) for (const x of f) parts.push(normalizeSearchText(x));
    else parts.push(normalizeSearchText(f));
  }
  return parts.filter(Boolean).join(' \u0001 ');
}

/** Every whitespace-separated query token must appear somewhere in the haystack. Empty query matches everything. */
export function matchesSearch(haystack: string, query: string): boolean {
  const tokens = normalizeSearchText(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => haystack.includes(t));
}
