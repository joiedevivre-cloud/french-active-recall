import { normalizeForDedup, type ExistingExpressionLookup } from '@/lib/csvImport';

// Parses the freeform bullet/dash-list notes a user copies out of a ChatGPT
// chat (NOT the strict 4-column CSV from src/content/chatgpt-prompt.md --
// that one goes through src/lib/csvImport.ts instead). No AI involved here;
// everything is plain string processing so a paste saves instantly.

export type PasteRowStatus = 'new' | 'duplicate' | 'needs_review';

export interface PasteParsedRow {
  lineNumber: number;
  originalLine: string;
  expressionFr: string;
  /** Empty string means "no meaning found on this line" -- queued for AI later. */
  meaningKo: string;
  tags: string[];
  isSentence: boolean;
  status: PasteRowStatus;
  existingExpressionId?: string;
  existingMeaningKo?: string | null;
}

export interface PasteParseResult {
  rows: PasteParsedRow[];
  needsReviewCount: number;
}

const HANGUL_SYLLABLE_START = 0xac00;
const HANGUL_SYLLABLE_END = 0xd7a3;
const CIRCLED_DIGIT_START = 0x2460; // (1)
const CIRCLED_DIGIT_END = 0x2473; // (20)
const CURLY_DOUBLE_LEFT = 0x201c;
const CURLY_DOUBLE_RIGHT = 0x201d;

const BULLET_CHARS = ['*', '-', '•', '·', '○', '▪', '➤'];
const ALWAYS_SEPARATORS = ['—', '–', '|', '→', '=', '\t'];
const SPACE_GATED_SEPARATORS = ['-', ':'];

function containsHangul(text: string): boolean {
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= HANGUL_SYLLABLE_START && cp <= HANGUL_SYLLABLE_END) return true;
  }
  return false;
}

function looksLikeHeadingOrBold(trimmedRawLine: string): boolean {
  if (trimmedRawLine.startsWith('#')) return true;
  return trimmedRawLine.startsWith('**') && trimmedRawLine.endsWith('**') && trimmedRawLine.length > 4;
}

function stripLeadingDecoration(line: string): string {
  let text = line.trimStart();

  while (text.startsWith('#')) {
    text = text.slice(1);
  }
  text = text.trimStart();

  if (text.length > 0) {
    const cp = text.codePointAt(0) ?? 0;
    if (cp >= CIRCLED_DIGIT_START && cp <= CIRCLED_DIGIT_END) {
      text = text.slice(1).trimStart();
    }
  }

  const numberedMatch = text.match(/^\d+[.)]\s*/);
  if (numberedMatch) {
    text = text.slice(numberedMatch[0].length);
  }

  if (text.length > 1 && BULLET_CHARS.includes(text[0]) && text[1] === ' ') {
    text = text.slice(2);
  }

  return text.trimStart();
}

function stripMarkdownEmphasis(text: string): string {
  return text.split('**').join('').split('`').join('');
}

function stripMarkdownTablePipes(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length > 1 && trimmed.startsWith('|') && trimmed.endsWith('|')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isMarkdownTableDividerRow(line: string): boolean {
  return line.includes('-') && /^[\s|:-]+$/.test(line);
}

// Markdown's "hard line break" convention is a line ending in one or more
// backslashes (or two-plus trailing spaces, handled by the trim elsewhere).
// Many chat/export tools emit this even for plain text, so a pasted
// sentence like "...simple.\" picks up a backslash that was never part of
// the French. French orthography has no legitimate use for a trailing
// backslash, so stripping it is always safe -- unlike a mid-word hyphen or
// apostrophe, which this function never touches.
function stripTrailingLineBreakBackslash(text: string): string {
  return text.replace(/\\+\s*$/, '').trimEnd();
}

function isCurlyDoubleQuote(char: string, codePoint: number): boolean {
  return codePoint === CURLY_DOUBLE_LEFT || codePoint === CURLY_DOUBLE_RIGHT || char === '"';
}

function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const firstCp = first.codePointAt(0) ?? 0;
  const lastCp = last.codePointAt(0) ?? 0;
  if (isCurlyDoubleQuote(first, firstCp) && isCurlyDoubleQuote(last, lastCp)) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function findSplitIndex(line: string): number | null {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const isAlwaysSeparator = ALWAYS_SEPARATORS.includes(ch);
    const isSpaceGatedSeparator =
      SPACE_GATED_SEPARATORS.includes(ch) && line[i - 1] === ' ' && line[i + 1] === ' ';
    if (!isAlwaysSeparator && !isSpaceGatedSeparator) continue;

    const left = line.slice(0, i);
    const right = line.slice(i + 1);
    if (!containsHangul(left) && containsHangul(right)) {
      return i;
    }
  }
  return null;
}

function endsWithSentencePunctuation(text: string): boolean {
  const last = text.trim().slice(-1);
  return last === '.' || last === '?' || last === '!';
}

export function parsePasteText(raw: string): PasteParseResult {
  const lines = raw.split(/\r?\n/);
  const rows: PasteParsedRow[] = [];
  let currentTags: string[] = [];

  lines.forEach((rawLine, index) => {
    const trimmedRaw = rawLine.trim();
    if (!trimmedRaw) return;

    const lineNumber = index + 1;
    const isHeadingOrBold = looksLikeHeadingOrBold(trimmedRaw);

    const withoutBullet = stripLeadingDecoration(trimmedRaw);
    const withoutEmphasis = stripMarkdownEmphasis(withoutBullet);
    const withoutTablePipes = stripMarkdownTablePipes(withoutEmphasis);
    const cleaned = stripTrailingLineBreakBackslash(withoutTablePipes).trim();
    if (!cleaned) return;
    if (isMarkdownTableDividerRow(cleaned)) return;

    const endsWithColon = cleaned.endsWith(':');
    const splitIndex = endsWithColon ? null : findSplitIndex(cleaned);

    if (splitIndex === null) {
      if (isHeadingOrBold || endsWithColon) {
        const title = (endsWithColon ? cleaned.slice(0, -1) : cleaned).trim();
        currentTags = title ? [title] : [];
        return;
      }

      if (!containsHangul(cleaned)) {
        rows.push({
          lineNumber,
          originalLine: rawLine,
          expressionFr: cleaned,
          meaningKo: '',
          tags: [...currentTags],
          isSentence: endsWithSentencePunctuation(cleaned),
          status: 'new',
        });
        return;
      }

      rows.push({
        lineNumber,
        originalLine: rawLine,
        expressionFr: '',
        meaningKo: '',
        tags: [...currentTags],
        isSentence: false,
        status: 'needs_review',
      });
      return;
    }

    const expressionFr = stripWrappingQuotes(cleaned.slice(0, splitIndex));
    const meaningKo = stripWrappingQuotes(cleaned.slice(splitIndex + 1));
    rows.push({
      lineNumber,
      originalLine: rawLine,
      expressionFr,
      meaningKo,
      tags: [...currentTags],
      isSentence: endsWithSentencePunctuation(expressionFr),
      status: 'new',
    });
  });

  return { rows, needsReviewCount: rows.filter((row) => row.status === 'needs_review').length };
}

/**
 * Marks rows as duplicates against existing DB expressions AND against
 * earlier rows in the same paste, using the same accent-preserving key as
 * src/lib/csvImport.ts (normalizeForDedup). Pasting the same block twice
 * never inserts the same expression twice.
 */
export function markPasteDuplicates(rows: PasteParsedRow[], existing: ExistingExpressionLookup[]): PasteParsedRow[] {
  const seen = new Map<string, ExistingExpressionLookup | null>();
  for (const row of existing) {
    seen.set(normalizeForDedup(row.expression_fr), row);
  }

  return rows.map((row) => {
    if (row.status === 'needs_review') return row;

    const key = normalizeForDedup(row.expressionFr);
    if (seen.has(key)) {
      const match = seen.get(key);
      return {
        ...row,
        status: 'duplicate' as const,
        existingExpressionId: match?.id,
        existingMeaningKo: match?.meaning_ko ?? null,
      };
    }

    seen.set(key, null);
    return row;
  });
}
