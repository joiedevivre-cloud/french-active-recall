import { describe, expect, it } from 'vitest';
import { effectiveAnalysisState, STALE_ANALYSIS_THRESHOLD_MS } from '@/features/ai-batch/staleAnalysis';

const NOW = new Date('2026-11-18T00:10:00.000Z').getTime();

describe('effectiveAnalysisState', () => {
  it('completed and failed pass through regardless of timestamps', () => {
    expect(effectiveAnalysisState({ aiAnalysisStatus: 'completed', analysisRequestedAt: null, meaningKo: '뜻' }, NOW)).toBe('completed');
    expect(effectiveAnalysisState({ aiAnalysisStatus: 'failed', analysisRequestedAt: null, meaningKo: null }, NOW)).toBe('failed');
  });

  it('pending with no meaning yet is "not_requested" -- never shown as analyzing', () => {
    expect(effectiveAnalysisState({ aiAnalysisStatus: 'pending', analysisRequestedAt: null, meaningKo: null }, NOW)).toBe(
      'not_requested'
    );
  });

  it('pending with an existing meaning (typed, or saved via /ai-batch) counts as completed', () => {
    expect(effectiveAnalysisState({ aiAnalysisStatus: 'pending', analysisRequestedAt: null, meaningKo: '뜻' }, NOW)).toBe(
      'completed'
    );
  });

  it('analyzing just now is genuinely in progress', () => {
    const requestedAt = new Date(NOW - 1000).toISOString();
    expect(effectiveAnalysisState({ aiAnalysisStatus: 'analyzing', analysisRequestedAt: requestedAt, meaningKo: null }, NOW)).toBe(
      'analyzing'
    );
  });

  it('analyzing right at the threshold is still in progress (exclusive upper bound check happens past it)', () => {
    const requestedAt = new Date(NOW - (STALE_ANALYSIS_THRESHOLD_MS - 1)).toISOString();
    expect(effectiveAnalysisState({ aiAnalysisStatus: 'analyzing', analysisRequestedAt: requestedAt, meaningKo: null }, NOW)).toBe(
      'analyzing'
    );
  });

  it('analyzing past the threshold is stalled, not an infinite spinner', () => {
    const requestedAt = new Date(NOW - STALE_ANALYSIS_THRESHOLD_MS - 1).toISOString();
    expect(effectiveAnalysisState({ aiAnalysisStatus: 'analyzing', analysisRequestedAt: requestedAt, meaningKo: null }, NOW)).toBe(
      'stalled'
    );
  });

  it('analyzing with no requested_at timestamp is treated as stalled (bad state, never gets stuck silently)', () => {
    expect(effectiveAnalysisState({ aiAnalysisStatus: 'analyzing', analysisRequestedAt: null, meaningKo: null }, NOW)).toBe(
      'stalled'
    );
  });
});
