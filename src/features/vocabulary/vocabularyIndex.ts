// Pure data logic for the 단어장 list (/vocabulary): joins lemmas, usages,
// sentence links, expressions and review states into one entry per lemma,
// and implements summary / search / filter / sort. No Supabase calls here
// -- see useVocabularyData.ts for loading and vocabularyIndex.test.ts.
import { buildSearchText, matchesSearch } from '@/lib/search';

export interface LemmaRecord {
  id: string;
  lemma: string;
  part_of_speech: string | null;
  pronunciation_ipa: string | null;
  grammar_notes: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string | null;
  // migration 0019 -- absent until it is applied, so all optional
  forms?: string[] | null;
  is_favorite?: boolean | null;
  word_analysis_status?: 'pending' | 'processing' | 'done' | 'failed' | null;
  // filled by the stage-2 word analysis (column added then); optional until it exists
  basic_meanings_ko?: string[] | null;
}

export interface UsageRecord {
  id: string;
  lemma_id: string;
  label: string;
  meaning_ko: string | null;
  pattern: string | null;
  sort_order: number;
  source: string | null;
}

export interface LinkRecord {
  expression_id: string;
  lemma_id: string | null;
  usage_id: string | null;
}

export interface ExpressionRecord {
  id: string;
  expression_fr: string;
  meaning_ko: string | null;
}

export interface ReviewRecord {
  expression_id: string | null;
  lemma_usage_id: string | null;
  due_at: string;
  lapses: number;
}

export type PosCategory = 'verb' | 'noun' | 'adjective' | 'adverb' | 'other';

export interface UsageEntry {
  usage: UsageRecord;
  expressionIds: string[];
}

export interface VocabularyEntry {
  lemma: LemmaRecord;
  posCategory: PosCategory;
  usages: UsageEntry[];
  /** linked sentences not attached to any usage of this lemma */
  unassignedExpressionIds: string[];
  expressionCount: number;
  usageCount: number;
  representativeMeaning: string | null;
  /** earliest due_at among this lemma's sentence cards and usage cards */
  nextDueAt: string | null;
  lapses: number;
  isFavorite: boolean;
  needsAnalysis: boolean;
  searchText: string;
}

export function posCategory(pos: string | null | undefined): PosCategory {
  const p = (pos ?? '').trim().toLowerCase();
  if (!p) return 'other';
  if (/^(verbe|verb|동사|대명동사)/.test(p) || p.includes('verbe')) return 'verb';
  if (/^(nom|noun|명사)/.test(p)) return 'noun';
  if (/^(adjectif|adjective|형용사)/.test(p)) return 'adjective';
  if (/^(adverbe|adverb|부사)/.test(p)) return 'adverb';
  return 'other';
}

export function buildVocabularyIndex(input: {
  lemmas: LemmaRecord[];
  usages: UsageRecord[];
  links: LinkRecord[];
  expressions: ExpressionRecord[];
  reviews: ReviewRecord[];
}): VocabularyEntry[] {
  const exprById = new Map(input.expressions.map((e) => [e.id, e]));
  const usagesByLemma = new Map<string, UsageRecord[]>();
  for (const u of input.usages) usagesByLemma.set(u.lemma_id, [...(usagesByLemma.get(u.lemma_id) ?? []), u]);
  const linksByLemma = new Map<string, LinkRecord[]>();
  for (const l of input.links) {
    if (!l.lemma_id || !exprById.has(l.expression_id)) continue; // deleted expressions drop out
    linksByLemma.set(l.lemma_id, [...(linksByLemma.get(l.lemma_id) ?? []), l]);
  }
  const reviewByExpr = new Map<string, ReviewRecord>();
  const reviewByUsage = new Map<string, ReviewRecord>();
  for (const r of input.reviews) {
    if (r.expression_id) reviewByExpr.set(r.expression_id, r);
    if (r.lemma_usage_id) reviewByUsage.set(r.lemma_usage_id, r);
  }

  return input.lemmas.map((lemma) => {
    const usages = [...(usagesByLemma.get(lemma.id) ?? [])].sort((a, b) => a.sort_order - b.sort_order);
    const links = linksByLemma.get(lemma.id) ?? [];
    const usageIds = new Set(usages.map((u) => u.id));
    const usageEntries: UsageEntry[] = usages.map((usage) => ({
      usage,
      expressionIds: links.filter((l) => l.usage_id === usage.id).map((l) => l.expression_id),
    }));
    const unassigned = links.filter((l) => !l.usage_id || !usageIds.has(l.usage_id)).map((l) => l.expression_id);
    const expressionIds = [...new Set(links.map((l) => l.expression_id))];

    const reviews = [
      ...expressionIds.map((id) => reviewByExpr.get(id)),
      ...usages.map((u) => reviewByUsage.get(u.id)),
    ].filter((r): r is ReviewRecord => !!r);
    const nextDueAt = reviews.reduce<string | null>((min, r) => (min === null || Date.parse(r.due_at) < Date.parse(min) ? r.due_at : min), null);

    const top = [...usageEntries].sort((a, b) => b.expressionIds.length - a.expressionIds.length || a.usage.sort_order - b.usage.sort_order)[0];
    const sentences = expressionIds.map((id) => exprById.get(id)!);

    return {
      lemma,
      posCategory: posCategory(lemma.part_of_speech),
      usages: usageEntries,
      unassignedExpressionIds: unassigned,
      expressionCount: expressionIds.length,
      usageCount: usages.length,
      representativeMeaning: top ? top.usage.meaning_ko || top.usage.label : null,
      nextDueAt,
      lapses: reviews.reduce((sum, r) => sum + (r.lapses ?? 0), 0),
      isFavorite: lemma.is_favorite === true,
      needsAnalysis: lemma.word_analysis_status !== 'done',
      searchText: buildSearchText([
        lemma.lemma,
        lemma.forms ?? [],
        usages.map((u) => u.label),
        usages.map((u) => u.meaning_ko),
        usages.map((u) => u.pattern),
        sentences.map((s) => s.expression_fr),
        sentences.map((s) => s.meaning_ko),
      ]),
    };
  });
}

export function endOfToday(now: Date = new Date()): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function isDueToday(entry: Pick<VocabularyEntry, 'nextDueAt'>, now: Date = new Date()): boolean {
  return entry.nextDueAt !== null && Date.parse(entry.nextDueAt) <= endOfToday(now);
}

export interface VocabularySummary {
  lemmaCount: number;
  usageCount: number;
  dueToday: number;
  analysisPending: number;
  analysisFailed: number;
  /** saved expressions that have no sentence analysis yet (never reached the 단어장) */
  unanalyzedExpressions: number;
}

export function summarize(entries: VocabularyEntry[], allExpressionIds: string[], linkedExpressionIds: Set<string>, now: Date = new Date()): VocabularySummary {
  return {
    lemmaCount: entries.length,
    usageCount: entries.reduce((s, e) => s + e.usageCount, 0),
    dueToday: entries.filter((e) => isDueToday(e, now)).length,
    analysisPending: entries.filter((e) => e.lemma.word_analysis_status !== 'done' && e.lemma.word_analysis_status !== 'failed').length,
    analysisFailed: entries.filter((e) => e.lemma.word_analysis_status === 'failed').length,
    unanalyzedExpressions: allExpressionIds.filter((id) => !linkedExpressionIds.has(id)).length,
  };
}

export type VocabularyFilter = 'all' | PosCategory | 'favorite' | 'needs_analysis' | 'due_today';
export type VocabularySort = 'recent' | 'alpha' | 'sentences' | 'due' | 'lapses';

export const FILTER_LABELS: [VocabularyFilter, string][] = [
  ['all', '전체'],
  ['verb', '동사'],
  ['noun', '명사'],
  ['adjective', '형용사'],
  ['adverb', '부사'],
  ['other', '기타'],
  ['favorite', '즐겨찾기'],
  ['needs_analysis', '분석 필요'],
  ['due_today', '오늘 복습'],
];

export const SORT_LABELS: [VocabularySort, string][] = [
  ['recent', '최근 추가'],
  ['alpha', '알파벳'],
  ['sentences', '연결 문장 수'],
  ['due', '복습 예정일'],
  ['lapses', '자주 틀림'],
];

export function filterAndSort(
  entries: VocabularyEntry[],
  opts: { query: string; filter: VocabularyFilter; sort: VocabularySort },
  now: Date = new Date()
): VocabularyEntry[] {
  const filtered = entries.filter((e) => {
    if (!matchesSearch(e.searchText, opts.query)) return false;
    switch (opts.filter) {
      case 'all':
        return true;
      case 'favorite':
        return e.isFavorite;
      case 'needs_analysis':
        return e.needsAnalysis;
      case 'due_today':
        return isDueToday(e, now);
      default:
        return e.posCategory === opts.filter;
    }
  });
  const byAlpha = (a: VocabularyEntry, b: VocabularyEntry) => a.lemma.lemma.localeCompare(b.lemma.lemma, 'fr', { sensitivity: 'base' });
  const sorted = [...filtered];
  switch (opts.sort) {
    case 'alpha':
      sorted.sort(byAlpha);
      break;
    case 'sentences':
      sorted.sort((a, b) => b.expressionCount - a.expressionCount || byAlpha(a, b));
      break;
    case 'due':
      sorted.sort((a, b) => {
        if (a.nextDueAt === b.nextDueAt) return byAlpha(a, b);
        if (a.nextDueAt === null) return 1;
        if (b.nextDueAt === null) return -1;
        return Date.parse(a.nextDueAt) - Date.parse(b.nextDueAt);
      });
      break;
    case 'lapses':
      sorted.sort((a, b) => b.lapses - a.lapses || byAlpha(a, b));
      break;
    case 'recent':
    default:
      sorted.sort((a, b) => Date.parse(b.lemma.created_at) - Date.parse(a.lemma.created_at) || byAlpha(a, b));
  }
  return sorted;
}

export function isVocabularyFilter(v: string | null): v is VocabularyFilter {
  return FILTER_LABELS.some(([k]) => k === v);
}
export function isVocabularySort(v: string | null): v is VocabularySort {
  return SORT_LABELS.some(([k]) => k === v);
}
