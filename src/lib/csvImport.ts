import Papa from 'papaparse';

// Shared by src/features/import/PasteImportPage.tsx (in-app "ChatGPT 결과
// 붙여넣기") and scripts/import-csv.ts (one-off backfill of an existing CSV
// file). Environment-agnostic: no Supabase/DOM/Node-only calls in this file
// so it works unmodified in the browser bundle and under tsx/Node.

export type SourceType =
  | 'manual'
  | 'school'
  | 'tv5monde'
  | 'daily'
  | 'news'
  | 'video'
  | 'ocr'
  | 'voice'
  | 'import'
  | 'import_anki'
  | 'b2_700';

export type ImportRowStatus = 'new' | 'duplicate' | 'error';

export interface ParsedImportRow {
  /** 1-based index among data rows (not the header, not the raw pasted text). */
  rowNumber: number;
  expressionFr: string;
  meaningKo: string;
  exampleFr: string | null;
  tags: string[];
  sourceLabel: string | null;
  sourceType: SourceType;
  status: ImportRowStatus;
  errorMessage: string | null;
  /** Only set once markDuplicates() runs. */
  existingExpressionId?: string;
  existingMeaningKo?: string | null;
}

export interface ParseImportResult {
  headerFound: boolean;
  delimiter: ',' | '\t' | null;
  rows: ParsedImportRow[];
}

export interface ExistingExpressionLookup {
  id: string;
  expression_fr: string;
  meaning_ko: string | null;
}

const EXPECTED_HEADERS = ['프랑스어', '한국어 뜻', '분류', '출처'] as const;
const CODE_FENCE = '```';

// Unicode code points for "smart"/curly quote variants. ChatGPT output
// sometimes uses these instead of straight quotes -- Papa.parse only
// recognizes straight double-quotes (") as its quote character, so a field
// like a French expression containing a comma, wrapped in curly quotes,
// would otherwise get split on that comma by mistake.
const CURLY_DOUBLE_LEFT = 0x201c; // "
const CURLY_DOUBLE_RIGHT = 0x201d; // "
const CURLY_SINGLE_LEFT = 0x2018; // '
const CURLY_SINGLE_RIGHT = 0x2019; // '

function normalizeQuoteChars(text: string): string {
  let result = '';
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp === CURLY_DOUBLE_LEFT || cp === CURLY_DOUBLE_RIGHT) {
      result += '"';
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Duplicate-detection key. Deliberately accent-PRESERVING (unlike
 * src/lib/normalizeFr.ts, which strips accents for the general quick-add
 * duplicate warning) -- in French, accents are often meaning-distinguishing
 * ("a" vs "à", "ou" vs "où"), so folding them away would wrongly merge
 * genuinely different expressions. Curly apostrophes ARE folded to the
 * straight form, since that is just a stylistic/typing difference, not a
 * linguistic one.
 */
export function normalizeForDedup(text: string): string {
  let result = '';
  for (const char of text.trim().toLowerCase().normalize('NFC')) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp === CURLY_SINGLE_LEFT || cp === CURLY_SINGLE_RIGHT) {
      result += "'";
    } else {
      result += char;
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

function stripCodeFence(raw: string): string {
  const firstFenceIndex = raw.indexOf(CODE_FENCE);
  if (firstFenceIndex === -1) return raw;

  const afterFenceLineBreak = raw.indexOf('\n', firstFenceIndex);
  const contentStart = afterFenceLineBreak === -1 ? firstFenceIndex + CODE_FENCE.length : afterFenceLineBreak + 1;

  const closingFenceIndex = raw.indexOf(CODE_FENCE, contentStart);
  return closingFenceIndex === -1 ? raw.slice(contentStart) : raw.slice(contentStart, closingFenceIndex);
}

function detectDelimiter(headerLine: string): ',' | '\t' {
  const tabCount = headerLine.split('\t').length - 1;
  const commaCount = headerLine.split(',').length - 1;
  return tabCount > commaCount ? '\t' : ',';
}

function extractTableLines(raw: string): { lines: string[]; delimiter: ',' | '\t' } | null {
  const fenced = stripCodeFence(raw);
  const normalized = normalizeQuoteChars(fenced);
  const allLines = normalized.split(/\r?\n/);

  const headerIndex = allLines.findIndex((line) => line.includes(EXPECTED_HEADERS[0]));
  if (headerIndex === -1) return null;

  const delimiter = detectDelimiter(allLines[headerIndex]);
  const tableLines = [allLines[headerIndex]];
  for (let i = headerIndex + 1; i < allLines.length; i++) {
    const line = allLines[i];
    if (line.trim() === '') break; // a blank line ends the table block
    tableLines.push(line);
  }
  return { lines: tableLines, delimiter };
}

function buildErrorRow(rowNumber: number, message: string): ParsedImportRow {
  return {
    rowNumber,
    expressionFr: '',
    meaningKo: '',
    exampleFr: null,
    tags: [],
    sourceLabel: null,
    sourceType: 'import',
    status: 'error',
    errorMessage: message,
  };
}

const SOURCE_LABEL_TO_TYPE: Record<string, SourceType> = {
  '학교 수업': 'school',
  '일상 대화': 'daily',
  뉴스: 'news',
  영상: 'video',
};

export function mapSourceLabelToType(label: string): SourceType {
  const trimmed = label.trim();
  if (trimmed.toLowerCase() === 'tv5monde') return 'tv5monde';
  return SOURCE_LABEL_TO_TYPE[trimmed] ?? 'import';
}

/** Splits "한국어 뜻" on " | " into the meaning and an optional French example. */
export function splitMeaningAndExample(raw: string): { meaningKo: string; exampleFr: string | null } {
  const parts = raw.split('|');
  if (parts.length < 2) {
    return { meaningKo: raw.trim(), exampleFr: null };
  }
  const meaningKo = parts[0].trim();
  const exampleFr = parts.slice(1).join('|').trim();
  return { meaningKo, exampleFr: exampleFr || null };
}

/**
 * Finds the 프랑스어/한국어 뜻/분류/출처 table inside arbitrary ChatGPT output
 * (plain CSV, a ```csv fenced block, prose before/after, or TSV) and maps
 * each row. Duplicate detection against the database is NOT done here (this
 * module has no DB access) -- call markDuplicates() with the caller's own
 * query results.
 */
export function parseImportText(raw: string): ParseImportResult {
  const extracted = extractTableLines(raw);
  if (!extracted) {
    return { headerFound: false, delimiter: null, rows: [] };
  }

  const { data } = Papa.parse<Record<string, string>>(extracted.lines.join('\n'), {
    header: true,
    delimiter: extracted.delimiter,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  const rows: ParsedImportRow[] = data.map((record, index) => {
    const rowNumber = index + 1;
    const cells = EXPECTED_HEADERS.map((h) => record[h]);

    if (cells.some((cell) => cell === undefined)) {
      return buildErrorRow(rowNumber, '열 개수가 맞지 않습니다');
    }

    const [expressionFrRaw, meaningRaw, tagRaw, sourceRaw] = cells as string[];
    const expressionFr = expressionFrRaw.trim();
    if (!expressionFr) {
      return buildErrorRow(rowNumber, '프랑스어 칸이 비어있습니다');
    }

    const { meaningKo, exampleFr } = splitMeaningAndExample(meaningRaw);
    const trimmedTag = tagRaw.trim();
    const trimmedSource = sourceRaw.trim();

    return {
      rowNumber,
      expressionFr,
      meaningKo,
      exampleFr,
      tags: trimmedTag ? [trimmedTag] : [],
      sourceLabel: trimmedSource || null,
      sourceType: mapSourceLabelToType(sourceRaw),
      status: 'new',
      errorMessage: null,
    };
  });

  return { headerFound: true, delimiter: extracted.delimiter, rows };
}

/**
 * Marks rows as 'duplicate' against (a) the caller-supplied existing
 * expressions and (b) earlier rows within the same batch, so pasting the
 * same block twice -- or a block with repeated lines -- never inserts twice.
 * Errors pass through untouched.
 */
export function markDuplicates(rows: ParsedImportRow[], existing: ExistingExpressionLookup[]): ParsedImportRow[] {
  const seen = new Map<string, ExistingExpressionLookup | null>();
  for (const row of existing) {
    seen.set(normalizeForDedup(row.expression_fr), row);
  }

  return rows.map((row) => {
    if (row.status === 'error') return row;

    const key = normalizeForDedup(row.expressionFr);
    if (seen.has(key)) {
      const match = seen.get(key);
      return {
        ...row,
        status: 'duplicate',
        existingExpressionId: match?.id,
        existingMeaningKo: match?.meaning_ko ?? null,
      };
    }

    seen.set(key, null); // null = "seen earlier in this batch", not a pre-existing DB row
    return { ...row, status: 'new' };
  });
}
