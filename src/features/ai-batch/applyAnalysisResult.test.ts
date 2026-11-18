import { describe, expect, it, vi, beforeEach } from 'vitest';
import { applyAnalysisResult, markAnalyzing, DETAILED_ANALYSIS_VERSION } from '@/features/ai-batch/applyAnalysisResult';
import { triggerAutoAnalysis } from '@/features/ai-batch/autoAnalyze';
import type { BatchItemResult, DetailedBatchItemResult } from '@/features/ai-batch/aiBatchClient';

const invokeMock = vi.fn();
let exampleExists = false;
let meaningKoUserEdited = false;
const calls: { table: string; method: string; args: unknown[] }[] = [];

function makeChain(table: string) {
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ table, method, args });
      return chain;
    };
  const chain: Record<string, unknown> = {
    update: record('update'),
    insert: record('insert'),
    select: record('select'),
    eq: record('eq'),
    in: record('in'),
    limit: record('limit'),
    maybeSingle: vi.fn(() => {
      if (table === 'expressions') {
        return Promise.resolve({ data: { meaning_ko_user_edited: meaningKoUserEdited }, error: null });
      }
      return Promise.resolve({ data: exampleExists ? { id: 'existing-example' } : null, error: null });
    }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
  };
  return chain;
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => makeChain(table),
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
  },
}));

function fakeResult(expressionFr: string): BatchItemResult {
  return {
    expression_fr: expressionFr,
    corrected_fr: null,
    meaning_ko: '뜻',
    grammar_note: '문법 설명',
    example_fr: '예문입니다.',
    example_translation_ko: '예문 번역',
    cefr_level: 'B1',
    tags: ['tag'],
    key_phrase: 'phrase',
  };
}

function fakeDetailedResult(expressionFr: string): DetailedBatchItemResult {
  return {
    ...fakeResult(expressionFr),
    core_pattern: null,
    sentence_structure: null,
    grammar_points: [{ pattern: 'il faut que + subjonctif', meaning: '필요성 표현', example: 'Il faut que tu partes.' }],
    vocabulary: [],
    common_mistakes: [],
    similar_expressions: [],
    example_sentences: [{ fr: '예문 A', ko: '뜻 A' }],
  };
}

beforeEach(() => {
  calls.length = 0;
  exampleExists = false;
  meaningKoUserEdited = false;
  invokeMock.mockReset();
});

describe('applyAnalysisResult', () => {
  it('marks ai_analysis_status failed and touches nothing else when result is null', async () => {
    await applyAnalysisResult('expr-1', null);
    const exprUpdates = calls.filter((c) => c.table === 'expressions' && c.method === 'update');
    expect(exprUpdates).toHaveLength(1);
    expect(exprUpdates[0].args[0]).toEqual({ ai_analysis_status: 'failed' });
    expect(calls.some((c) => c.table === 'expression_examples')).toBe(false);
  });

  it('writes the full analysis onto the expression on success', async () => {
    await applyAnalysisResult('expr-1', fakeResult('x'));
    const update = calls.find((c) => c.table === 'expressions' && c.method === 'update');
    expect(update?.args[0]).toMatchObject({
      meaning_ko: '뜻',
      grammar_note: '문법 설명',
      cefr_level: 'B1',
      key_phrase: 'phrase',
      ai_analysis_status: 'completed',
    });
  });

  it('inserts a new example when none exists yet', async () => {
    exampleExists = false;
    await applyAnalysisResult('expr-1', fakeResult('x'));
    expect(calls.some((c) => c.table === 'expression_examples' && c.method === 'insert')).toBe(true);
    expect(calls.some((c) => c.table === 'expression_examples' && c.method === 'update')).toBe(false);
  });

  it('updates the existing example instead of inserting a duplicate (re-analysis is idempotent)', async () => {
    exampleExists = true;
    await applyAnalysisResult('expr-1', fakeResult('x'));
    expect(calls.some((c) => c.table === 'expression_examples' && c.method === 'update')).toBe(true);
    expect(calls.some((c) => c.table === 'expression_examples' && c.method === 'insert')).toBe(false);
  });

  it('retrying after a failure applies a real result on the next attempt', async () => {
    await applyAnalysisResult('expr-1', null);
    expect(calls.find((c) => c.table === 'expressions')?.args[0]).toEqual({ ai_analysis_status: 'failed' });

    calls.length = 0;
    await applyAnalysisResult('expr-1', fakeResult('x'));
    expect(calls.find((c) => c.table === 'expressions' && c.method === 'update')?.args[0]).toMatchObject({
      ai_analysis_status: 'completed',
    });
  });

  it('protects a user-edited meaning_ko from being overwritten, but still updates other fields', async () => {
    meaningKoUserEdited = true;
    await applyAnalysisResult('expr-1', fakeResult('x'));
    const update = calls.find((c) => c.table === 'expressions' && c.method === 'update')?.args[0] as Record<string, unknown>;
    expect(update.meaning_ko).toBeUndefined();
    expect(update.grammar_note).toBe('문법 설명');
    expect(update.ai_analysis_status).toBe('completed');
  });

  it('overwrites meaning_ko normally when the user never edited it', async () => {
    meaningKoUserEdited = false;
    await applyAnalysisResult('expr-1', fakeResult('x'));
    const update = calls.find((c) => c.table === 'expressions' && c.method === 'update')?.args[0] as Record<string, unknown>;
    expect(update.meaning_ko).toBe('뜻');
  });

  it('writes detailed_analysis/analyzed_at/analysis_version for a detailed result', async () => {
    await applyAnalysisResult('expr-1', fakeDetailedResult('x'));
    const update = calls.find((c) => c.table === 'expressions' && c.method === 'update')?.args[0] as Record<string, unknown>;
    expect(update.analysis_version).toBe(DETAILED_ANALYSIS_VERSION);
    expect(update.analyzed_at).toBeTypeOf('string');
    expect(update.detailed_analysis).toMatchObject({
      grammar_points: [{ pattern: 'il faut que + subjonctif', meaning: '필요성 표현', example: 'Il faut que tu partes.' }],
    });
  });

  it('does not write detailed_analysis fields for a light (non-detailed) result', async () => {
    await applyAnalysisResult('expr-1', fakeResult('x'));
    const update = calls.find((c) => c.table === 'expressions' && c.method === 'update')?.args[0] as Record<string, unknown>;
    expect(update.detailed_analysis).toBeUndefined();
    expect(update.analysis_version).toBeUndefined();
  });
});

describe('markAnalyzing', () => {
  it('stamps analyzing status + a requested_at timestamp for the given ids', async () => {
    await markAnalyzing(['a', 'b']);
    const update = calls.find((c) => c.table === 'expressions' && c.method === 'update');
    expect((update?.args[0] as Record<string, unknown>).ai_analysis_status).toBe('analyzing');
    expect((update?.args[0] as Record<string, unknown>).analysis_requested_at).toBeTypeOf('string');
    const inCall = calls.find((c) => c.table === 'expressions' && c.method === 'in');
    expect(inCall?.args).toEqual(['id', ['a', 'b']]);
  });

  it('makes no call for an empty list', async () => {
    await markAnalyzing([]);
    expect(calls).toHaveLength(0);
  });
});

describe('triggerAutoAnalysis', () => {
  it('does nothing and makes no network call for an empty list', async () => {
    await triggerAutoAnalysis([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('stamps analyzing before calling, then applies a result to every row on a successful batch', async () => {
    invokeMock.mockResolvedValue({ data: { ok: true, results: [fakeResult('a'), fakeResult('b')] }, error: null });
    await triggerAutoAnalysis([
      { expressionId: 'id-a', expressionFr: 'a' },
      { expressionId: 'id-b', expressionFr: 'b' },
    ]);
    const updates = calls.filter((c) => c.table === 'expressions' && c.method === 'update');
    // 1 markAnalyzing call (both ids via .in()) + 2 per-row applyAnalysisResult calls.
    expect(updates).toHaveLength(3);
    const finalUpdates = updates.filter((u) => (u.args[0] as { ai_analysis_status: string }).ai_analysis_status !== 'analyzing');
    expect(finalUpdates).toHaveLength(2);
    expect(finalUpdates.every((u) => (u.args[0] as { ai_analysis_status: string }).ai_analysis_status === 'completed')).toBe(true);
  });

  it('marks rows failed when the Edge Function call errors', async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: 'openai_call_failed' } });
    await triggerAutoAnalysis([{ expressionId: 'id-a', expressionFr: 'a' }]);
    const update = calls.filter((c) => c.table === 'expressions' && c.method === 'update').slice(-1)[0];
    expect(update?.args[0]).toEqual({ ai_analysis_status: 'failed' });
  });

  it('marks rows failed on a network exception without throwing', async () => {
    invokeMock.mockRejectedValue(new Error('network down'));
    await expect(
      triggerAutoAnalysis([{ expressionId: 'id-a', expressionFr: 'a' }])
    ).resolves.toBeUndefined();
    const update = calls.filter((c) => c.table === 'expressions' && c.method === 'update').slice(-1)[0];
    expect(update?.args[0]).toEqual({ ai_analysis_status: 'failed' });
  });
});
