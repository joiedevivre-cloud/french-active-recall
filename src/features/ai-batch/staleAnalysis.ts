// A row stuck in ai_analysis_status = 'analyzing' with no response ever
// coming back (network drop, tab closed mid-request, an exception in the
// Edge Function that somehow escaped even the catch-all) used to show
// "AI 분석 중..." forever, with no way to tell it apart from a genuinely
// in-flight request. analysis_requested_at + this threshold is the fix:
// past it, the row is treated as stalled and offered a retry instead.
export const STALE_ANALYSIS_THRESHOLD_MS = 90_000;

export type EffectiveAnalysisState = 'not_requested' | 'analyzing' | 'stalled' | 'completed' | 'failed';

export interface AnalysisStatusInput {
  aiAnalysisStatus: string;
  analysisRequestedAt: string | null;
  meaningKo: string | null;
}

export function effectiveAnalysisState(input: AnalysisStatusInput, now: number = Date.now()): EffectiveAnalysisState {
  if (input.aiAnalysisStatus === 'completed') return 'completed';
  if (input.aiAnalysisStatus === 'failed') return 'failed';

  if (input.aiAnalysisStatus === 'analyzing') {
    if (!input.analysisRequestedAt) return 'stalled'; // analyzing with no timestamp is itself a bad state
    const elapsed = now - new Date(input.analysisRequestedAt).getTime();
    return elapsed >= STALE_ANALYSIS_THRESHOLD_MS ? 'stalled' : 'analyzing';
  }

  // 'pending' (or 'skipped'): never actually requested. If the user
  // already has a meaning (typed as "fr — ko", or saved via /ai-batch
  // which analyzes before saving), there's nothing to request.
  return input.meaningKo ? 'completed' : 'not_requested';
}
