import { supabase } from '@/lib/supabase';
import type { DbRating } from '@/lib/fsrs';

export type WritingMode = 'transform' | 'korean_prompt' | 'situational' | 'speaking';

export interface GeneratedExercise {
  id: string;
  mode: WritingMode;
  promptKo: string;
  promptFrPattern: string | null;
  scenarioContext: { situation: string; role_ko: string; constraints_ko: string } | null;
  grammarTags: string[];
}

export interface GenerateOutcome {
  status: 'success' | 'failed';
  exercise?: GeneratedExercise;
  cached?: boolean;
  error?: string;
}

export interface CorrectionResult {
  meaning_ok: boolean;
  grammar_errors: { text: string; note_ko: string }[];
  vocab_preposition_errors: { text: string; note_ko: string }[];
  tense_conjugation_errors: { text: string; note_ko: string }[];
  naturalness_notes_ko: string | null;
  target_grammar_used: boolean | null;
  corrected_fr: string | null;
  explanation_ko: string;
  grammar_error_tags: string[];
}

export interface CorrectOutcome {
  status: 'success' | 'failed';
  correction?: CorrectionResult;
  aiSuggestedRating?: DbRating;
  error?: string;
}

/**
 * supabase-js's invoke() error.message is always a generic non-2xx
 * sentence -- the real status/body lives on the separate `response`
 * field. Same unwrapping as aiBatchClient.ts's describeInvokeError.
 */
async function describeInvokeError(response: Response | undefined): Promise<string> {
  if (!response) return 'network_error (no response reached the server)';
  try {
    const cloned = response.clone();
    const contentType = cloned.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json') ? await cloned.json() : (await cloned.text()).slice(0, 300);
    const bodyText = typeof body === 'string' ? body : body?.message ?? body?.error ?? JSON.stringify(body);
    return `HTTP ${response.status}: ${String(bodyText).replace(/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')}`;
  } catch {
    return `HTTP ${response.status}: (response body could not be read)`;
  }
}

export async function generateExercise(
  expressionId: string,
  mode: WritingMode,
  options?: { grammarTags?: string[]; forceNew?: boolean }
): Promise<GenerateOutcome> {
  try {
    const { data, error, response } = await supabase.functions.invoke('writing-practice', {
      body: { action: 'generate', expressionId, mode, grammarTags: options?.grammarTags ?? [], forceNew: options?.forceNew ?? false },
    });
    if (error) return { status: 'failed', error: await describeInvokeError(response) };
    if (!data?.ok) return { status: 'failed', error: data?.error ?? 'invalid_response' };
    return { status: 'success', exercise: data.exercise, cached: data.cached };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'unknown_error' };
  }
}

export async function correctAnswer(input: {
  exerciseId: string | null;
  expressionId: string;
  mode: WritingMode;
  grammarTags: string[];
  userAnswerFr: string;
  targetGrammar?: string | null;
}): Promise<CorrectOutcome> {
  try {
    const { data, error, response } = await supabase.functions.invoke('writing-practice', {
      body: { action: 'correct', ...input },
    });
    if (error) return { status: 'failed', error: await describeInvokeError(response) };
    if (!data?.ok) return { status: 'failed', error: data?.error ?? 'invalid_response' };
    return { status: 'success', correction: data.correction, aiSuggestedRating: data.aiSuggestedRating };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'unknown_error' };
  }
}
