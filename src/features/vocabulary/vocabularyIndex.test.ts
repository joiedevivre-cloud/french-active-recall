import { describe, expect, it } from 'vitest';
import { buildSearchText, matchesSearch, normalizeSearchText } from '@/lib/search';
import {
  buildVocabularyIndex,
  filterAndSort,
  isDueToday,
  posCategory,
  summarize,
  type ExpressionRecord,
  type LemmaRecord,
  type LinkRecord,
  type ReviewRecord,
  type UsageRecord,
} from '@/features/vocabulary/vocabularyIndex';
import { planSaveAnalysis } from '@/features/ai-batch/autoAnalyze';

describe('shared search module (home + 단어장)', () => {
  it('ignores accents, case and apostrophe style', () => {
    expect(normalizeSearchText('  Élève  Où ')).toBe('eleve ou');
    expect(normalizeSearchText('N’oublie')).toBe(normalizeSearchText("N'oublie"));
  });

  it('matches every token across fields, accent-insensitively', () => {
    const hay = buildSearchText(['mettre', ['mise', 'mis'], '~하기 시작하다', 'se mettre à + infinitif']);
    expect(matchesSearch(hay, 'MISE')).toBe(true);
    expect(matchesSearch(hay, 'mettre a')).toBe(true);
    expect(matchesSearch(hay, '시작')).toBe(true);
    expect(matchesSearch(hay, 'baisser')).toBe(false);
    expect(matchesSearch(hay, '   ')).toBe(true);
  });
});

// --- fixtures (shape of the real tables, made-up ids) ---------------------
const now = new Date('2026-11-18T12:00:00');
const lemmas: LemmaRecord[] = [
  { id: 'L-mettre', lemma: 'mettre', part_of_speech: 'verbe', pronunciation_ipa: '/mɛtʁ/', grammar_notes: {}, created_at: '2026-11-17T10:00:00Z', forms: ['mise', 'mis', 'mets'], is_favorite: true, word_analysis_status: 'pending' },
  { id: 'L-sembler', lemma: 'sembler', part_of_speech: 'verbe', pronunciation_ipa: null, grammar_notes: {}, created_at: '2026-11-18T09:00:00Z', word_analysis_status: 'done' },
  { id: 'L-emploi', lemma: 'emploi', part_of_speech: 'nom masculin', pronunciation_ipa: null, grammar_notes: {}, created_at: '2026-11-16T09:00:00Z' },
  { id: 'L-ete', lemma: 'été', part_of_speech: 'nom', pronunciation_ipa: null, grammar_notes: {}, created_at: '2026-11-15T09:00:00Z', word_analysis_status: 'failed' },
];
const usages: UsageRecord[] = [
  { id: 'U-sm', lemma_id: 'L-mettre', label: '~하기 시작하다', meaning_ko: '시작하다', pattern: 'se mettre à + infinitif', sort_order: 1, source: 'learned' },
  { id: 'U-poser', lemma_id: 'L-mettre', label: '놓다', meaning_ko: '두다', pattern: 'mettre + GN + lieu', sort_order: 0, source: 'learned' },
  { id: 'U-sembler', lemma_id: 'L-sembler', label: '~처럼 보이다', meaning_ko: null, pattern: 'sembler + adj', sort_order: 0, source: 'learned' },
];
const expressions: ExpressionRecord[] = [
  { id: 'E1', expression_fr: 'Je me suis mise à chercher un nouvel emploi.', meaning_ko: '새 일자리를 찾기 시작했다' },
  { id: 'E2', expression_fr: 'Je me mets au travail.', meaning_ko: null },
  { id: 'E3', expression_fr: 'Je mets mes clés sur la table.', meaning_ko: '열쇠를 놓다' },
  { id: 'E4', expression_fr: 'Il semble fatigué.', meaning_ko: null },
  { id: 'E5', expression_fr: 'Unanalyzed sentence.', meaning_ko: null },
];
const links: LinkRecord[] = [
  { expression_id: 'E1', lemma_id: 'L-mettre', usage_id: 'U-sm' },
  { expression_id: 'E2', lemma_id: 'L-mettre', usage_id: 'U-sm' },
  { expression_id: 'E3', lemma_id: 'L-mettre', usage_id: 'U-poser' },
  { expression_id: 'E4', lemma_id: 'L-sembler', usage_id: null },
  { expression_id: 'E-deleted', lemma_id: 'L-sembler', usage_id: 'U-sembler' }, // soft-deleted expression
];
const reviews: ReviewRecord[] = [
  { expression_id: 'E1', lemma_usage_id: null, due_at: '2026-11-18T08:00:00', lapses: 2 },
  { expression_id: 'E3', lemma_usage_id: null, due_at: '2026-11-25T08:00:00', lapses: 0 },
  { expression_id: null, lemma_usage_id: 'U-sm', due_at: '2026-11-20T08:00:00', lapses: 1 },
  { expression_id: 'E4', lemma_usage_id: null, due_at: '2026-11-30T08:00:00', lapses: 0 },
];
const entries = buildVocabularyIndex({ lemmas, usages, links, expressions, reviews });
const byId = (id: string) => entries.find((e) => e.lemma.id === id)!;

describe('buildVocabularyIndex', () => {
  it('counts usages and linked sentences per lemma, ordered by sort_order', () => {
    const m = byId('L-mettre');
    expect(m.usageCount).toBe(2);
    expect(m.expressionCount).toBe(3);
    expect(m.usages.map((u) => u.usage.id)).toEqual(['U-poser', 'U-sm']);
    expect(m.usages.find((u) => u.usage.id === 'U-sm')!.expressionIds).toEqual(['E1', 'E2']);
  });

  it('representative meaning = the usage with the most saved sentences', () => {
    expect(byId('L-mettre').representativeMeaning).toBe('시작하다');
    expect(byId('L-sembler').representativeMeaning).toBe('~처럼 보이다'); // falls back to label
  });

  it('drops links to deleted expressions and keeps unassigned sentences visible', () => {
    const s = byId('L-sembler');
    expect(s.expressionCount).toBe(1);
    expect(s.unassignedExpressionIds).toEqual(['E4']);
  });

  it('earliest due date and lapses combine sentence cards and usage cards', () => {
    const m = byId('L-mettre');
    expect(m.nextDueAt).toBe('2026-11-18T08:00:00');
    expect(m.lapses).toBe(3);
    expect(isDueToday(m, now)).toBe(true);
    expect(isDueToday(byId('L-sembler'), now)).toBe(false);
  });

  it('maps French and Korean parts of speech to filter categories', () => {
    expect(posCategory('verbe')).toBe('verb');
    expect(posCategory('verbe pronominal')).toBe('verb');
    expect(posCategory('nom masculin')).toBe('noun');
    expect(posCategory('형용사')).toBe('adjective');
    expect(posCategory('expression')).toBe('other');
    expect(posCategory(null)).toBe('other');
  });

  it('works before migration 0019 (no forms / is_favorite / status columns)', () => {
    const e = byId('L-emploi');
    expect(e.isFavorite).toBe(false);
    expect(e.needsAnalysis).toBe(true);
  });
});

describe('search / filter / sort', () => {
  const run = (query: string, filter: Parameters<typeof filterAndSort>[1]['filter'] = 'all', sort: Parameters<typeof filterAndSort>[1]['sort'] = 'alpha') =>
    filterAndSort(entries, { query, filter, sort }, now).map((e) => e.lemma.lemma);

  it('finds a lemma by conjugated form, Korean meaning, pattern or saved sentence', () => {
    expect(run('mise')).toEqual(['mettre']);
    expect(run('시작')).toEqual(['mettre']);
    expect(run('infinitif')).toEqual(['mettre']);
    expect(run('fatigue')).toEqual(['sembler']); // accent-insensitive sentence match
    expect(run('ete')).toEqual(['été']);
  });

  it('filters', () => {
    expect(run('', 'verb')).toEqual(['mettre', 'sembler']);
    expect(run('', 'noun')).toEqual(['emploi', 'été']);
    expect(run('', 'favorite')).toEqual(['mettre']);
    expect(run('', 'needs_analysis')).toEqual(['emploi', 'été', 'mettre']);
    expect(run('', 'due_today')).toEqual(['mettre']);
  });

  it('sorts', () => {
    expect(run('', 'all', 'recent')).toEqual(['sembler', 'mettre', 'emploi', 'été']);
    expect(run('', 'all', 'sentences')[0]).toBe('mettre');
    expect(run('', 'all', 'due')).toEqual(['mettre', 'sembler', 'emploi', 'été']); // no due date last
    expect(run('', 'all', 'lapses')[0]).toBe('mettre');
  });

  it('summary', () => {
    const linked = new Set(links.map((l) => l.expression_id));
    expect(summarize(entries, expressions.map((e) => e.id), linked, now)).toEqual({
      lemmaCount: 4,
      usageCount: 3,
      dueToday: 1,
      analysisPending: 2,
      analysisFailed: 1,
      unanalyzedExpressions: 1,
    });
  });
});

describe('save-time analysis plan (bug fix: word analysis for every saved row)', () => {
  it('meaning analysis only for rows without a meaning; sentence/word analysis for all', () => {
    const plan = planSaveAnalysis([
      { expressionId: 'a', expressionFr: 'Je mets la table.', needsMeaning: false },
      { expressionId: 'b', expressionFr: 'Il fait chaud.', needsMeaning: true },
      { expressionId: 'c', expressionFr: 'Sans flag.' },
      { expressionId: 'd', expressionFr: '   ', needsMeaning: true },
    ]);
    expect(plan.meaningRows.map((r) => r.expressionId)).toEqual(['b', 'c']);
    expect(plan.lemmaExpressionIds).toEqual(['a', 'b', 'c']);
  });
});
