import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  chunkSentences,
  analyzeChunk,
  analyzeSentencesInChunks,
  failedSentencesFrom,
  CHUNK_SIZE,
  type BatchItemResult,
} from '@/features/ai-batch/aiBatchClient';

const invokeMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
  },
}));

function fakeResult(expressionFr: string): BatchItemResult {
  return {
    expression_fr: expressionFr,
    corrected_fr: null,
    meaning_ko: '뜻',
    grammar_note: '설명',
    example_fr: '예문',
    example_translation_ko: '예문 뜻',
    cefr_level: 'B1',
    tags: ['tag'],
    key_phrase: 'phrase',
  };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe('chunkSentences', () => {
  it('splits into CHUNK_SIZE-sized groups', () => {
    const sentences = Array.from({ length: 32 }, (_, i) => `s${i}`);
    const chunks = chunkSentences(sentences);
    expect(chunks).toHaveLength(Math.ceil(32 / CHUNK_SIZE));
    expect(chunks[0]).toHaveLength(CHUNK_SIZE);
    expect(chunks.flat()).toEqual(sentences);
  });

  it('handles exact multiples without an empty trailing chunk', () => {
    const sentences = Array.from({ length: CHUNK_SIZE * 2 }, (_, i) => `s${i}`);
    const chunks = chunkSentences(sentences);
    expect(chunks).toHaveLength(2);
  });

  it('handles fewer sentences than one chunk', () => {
    expect(chunkSentences(['a', 'b'])).toEqual([['a', 'b']]);
  });

  it('handles empty input', () => {
    expect(chunkSentences([])).toEqual([]);
  });
});

describe('analyzeChunk', () => {
  it('returns success with results matched in order', async () => {
    const sentences = ['Je pense à lui.', 'Il pleut.'];
    invokeMock.mockResolvedValue({
      data: { ok: true, results: sentences.map(fakeResult) },
      error: null,
    });

    const result = await analyzeChunk(sentences);
    expect(result.status).toBe('success');
    expect(result.results).toHaveLength(2);
    expect(result.results?.[0].expression_fr).toBe('Je pense à lui.');
  });

  it('fails when the server returns an error, reading the real status/body instead of the generic message', async () => {
    const response = new Response(JSON.stringify({ error: 'daily_limit_exceeded' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: 'Edge Function returned a non-2xx status code' },
      response,
    });
    const result = await analyzeChunk(['a']);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('HTTP 429: daily_limit_exceeded');
  });

  it('falls back to a network_error label when invoke fails with no response at all', async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: 'fetch failed' }, response: undefined });
    const result = await analyzeChunk(['a']);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('network_error');
  });

  it('redacts anything that looks like an API key in the error body', async () => {
    const response = new Response(JSON.stringify({ message: 'bad key sk-abcdefghijklmnop' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
    invokeMock.mockResolvedValue({ data: null, error: { message: 'non-2xx' }, response });
    const result = await analyzeChunk(['a']);
    expect(result.error).not.toContain('sk-abcdefghijklmnop');
    expect(result.error).toContain('[REDACTED]');
  });

  it('fails when the result count does not match the input count', async () => {
    invokeMock.mockResolvedValue({
      data: { ok: true, results: [fakeResult('a')] }, // only 1 result for 2 inputs
      error: null,
    });
    const result = await analyzeChunk(['a', 'b']);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('result_count_mismatch');
  });

  it('fails cleanly when invoke throws', async () => {
    invokeMock.mockRejectedValue(new Error('network down'));
    const result = await analyzeChunk(['a']);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('network down');
  });

  it('fails when data.ok is falsy', async () => {
    invokeMock.mockResolvedValue({ data: { ok: false, error: 'openai_disabled' }, error: null });
    const result = await analyzeChunk(['a']);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('openai_disabled');
  });
});

describe('analyzeSentencesInChunks', () => {
  it('calls once per chunk and reports progress after each', async () => {
    const sentences = Array.from({ length: CHUNK_SIZE + 3 }, (_, i) => `s${i}`);
    invokeMock.mockImplementation((_fn, opts) => {
      const chunk = opts.body.sentences as string[];
      return Promise.resolve({ data: { ok: true, results: chunk.map(fakeResult) }, error: null });
    });

    const progress: Array<[number, number]> = [];
    const results = await analyzeSentencesInChunks(sentences, (done, total) => progress.push([done, total]));

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(progress).toEqual([
      [CHUNK_SIZE, sentences.length],
      [sentences.length, sentences.length],
    ]);
  });

  it('keeps going after a chunk fails', async () => {
    let call = 0;
    invokeMock.mockImplementation((_fn, opts) => {
      call++;
      const chunk = opts.body.sentences as string[];
      if (call === 1) return Promise.resolve({ data: null, error: { message: 'boom' } });
      return Promise.resolve({ data: { ok: true, results: chunk.map(fakeResult) }, error: null });
    });

    const sentences = Array.from({ length: CHUNK_SIZE + 2 }, (_, i) => `s${i}`);
    const results = await analyzeSentencesInChunks(sentences);
    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('success');
  });
});

describe('failedSentencesFrom', () => {
  it('flattens only the failed chunks', () => {
    const results = [
      { sentences: ['a', 'b'], status: 'failed' as const },
      { sentences: ['c'], status: 'success' as const, results: [fakeResult('c')] },
      { sentences: ['d', 'e'], status: 'failed' as const },
    ];
    expect(failedSentencesFrom(results)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('returns an empty array when nothing failed', () => {
    const results = [{ sentences: ['a'], status: 'success' as const, results: [fakeResult('a')] }];
    expect(failedSentencesFrom(results)).toEqual([]);
  });
});
