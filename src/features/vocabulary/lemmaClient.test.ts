import { describe, expect, it, vi, beforeEach } from 'vitest';
import { analyzeLemmaBatch } from '@/features/vocabulary/lemmaClient';

const invokeMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
  },
}));

beforeEach(() => {
  invokeMock.mockReset();
});

describe('analyzeLemmaBatch', () => {
  it('returns success immediately for an empty id list without calling invoke', async () => {
    const result = await analyzeLemmaBatch([]);
    expect(result).toEqual({ status: 'success', results: [] });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('passes expressionIds and force through to analyze-lemma', async () => {
    invokeMock.mockResolvedValue({ data: { ok: true, results: [{ expression_id: 'e1', status: 'success' }] }, error: null });
    await analyzeLemmaBatch(['e1'], true);
    expect(invokeMock).toHaveBeenCalledWith('analyze-lemma', { body: { expressionIds: ['e1'], force: true } });
  });

  it('reports failed when the function returns an error', async () => {
    invokeMock.mockResolvedValue({ data: { error: 'daily_limit_exceeded' }, error: { message: 'non-2xx' } });
    const result = await analyzeLemmaBatch(['e1']);
    expect(result).toEqual({ status: 'failed', error: 'daily_limit_exceeded' });
  });

  it('splits more than 20 ids into multiple calls and merges results', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `e${i}`);
    invokeMock
      .mockResolvedValueOnce({ data: { ok: true, results: ids.slice(0, 20).map((id) => ({ expression_id: id, status: 'success' })) }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, results: ids.slice(20).map((id) => ({ expression_id: id, status: 'success' })) }, error: null });
    const result = await analyzeLemmaBatch(ids);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success');
    expect(result.results).toHaveLength(25);
  });

  it('never throws on a network exception', async () => {
    invokeMock.mockRejectedValue(new Error('network down'));
    const result = await analyzeLemmaBatch(['e1']);
    expect(result).toEqual({ status: 'failed', error: 'network down' });
  });
});
