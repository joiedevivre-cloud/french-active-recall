import { supabase } from '@/lib/supabase';

// Lowered from 15: a real production failure ("Unterminated string in
// JSON", i.e. OpenAI's response got cut off mid-generation) traced back to
// analyze-batch requesting a fixed, too-small max_tokens regardless of
// chunk size (fixed server-side too -- see supabase/functions/analyze-batch
// computeMaxOutputTokens). A smaller chunk needs less output per request,
// which keeps it comfortably under the server's token ceiling with margin.
export const CHUNK_SIZE = 6;
const MAX_SPLIT_RETRY_DEPTH = 2;

export interface BatchItemResult {
  expression_fr: string;
  corrected_fr: string | null;
  meaning_ko: string;
  grammar_note: string;
  example_fr: string;
  example_translation_ko: string;
  cefr_level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  tags: string[];
  key_phrase: string;
}

export interface SentenceStructure {
  main_clause: string;
  conjunction: string;
  subordinate_clause: string;
  core_structure: string;
  infinitive: string;
  conjugated_form: string;
  mood_explanation: string;
  mood_contrast: string;
  overall_meaning: string;
}

export interface VocabularyItem {
  word: string;
  part_of_speech: string;
  meaning_ko: string;
  infinitive: string | null;
  tense_or_conjugation: string | null;
  gender_agreement: string | null;
  preposition: string | null;
  /** v3: a REAL error in THIS sentence involving this word (null whenever the sentence is correct -- enforced by guardDetailedResult). */
  sentence_error?: string | null;
  /** v3: a general rule worth knowing -- shown as a learning point, never as a warning. */
  learning_point?: string | null;
  /** Legacy (detailed-v1/v2) mixed field -- rendered as a learning point, never as a warning. */
  common_mistake?: string | null;
}

export type RequiredComplement = 'nom' | 'pronom' | 'infinitif' | 'clause' | 'independent';
export type MoodRequirement = 'indicatif' | 'subjonctif' | 'conditionnel' | 'none';

/** v3: same idea, different construction (e.g. malgré + GN -> bien que + proposition au subjonctif). */
export interface GrammarAlternative {
  expression: string;
  construction: string;
  required_complement: RequiredComplement;
  mood_requirement: MoodRequirement;
  meaning_ko: string;
  nuance_ko: string;
  register: 'familier' | 'courant' | 'soutenu';
  rewritten_sentence: string;
}

/**
 * A "Construction grammaticale" card. pattern/meaning/example exist on
 * every version; everything else is v3-only and optional so legacy rows
 * (detailed-v1/v2) render through the same component.
 */
export interface GrammarPoint {
  pattern: string;
  meaning: string;
  example: string;
  meaning_ko?: string;
  required_complement?: RequiredComplement;
  mood_requirement?: MoodRequirement;
  preposition_rule?: string | null;
  form_in_sentence?: string;
  incorrect_example?: { fr: string; reason_ko: string } | null;
  alternatives?: GrammarAlternative[];
  learning_tips?: string[];
}

/** v3: one grammatical relation in the sentence; multi-word units stay one component. */
export interface StructureComponent {
  text: string;
  function_fr: string;
  note_ko: string;
}

/**
 * v2: the PRIMARY field of a detailed analysis -- catches multi-word
 * idiomatic/semi-auxiliary patterns (se mettre à + infinitif, avoir beau +
 * infinitif, etc.) that sentence_structure (clause-based only) and a
 * word-by-word vocabulary breakdown both miss. See README "AI 분석 품질".
 */
export interface CorePattern {
  pattern: string;
  meaning_ko: string;
  matched_form: string;
  explanation_ko: string;
}

/**
 * Only returned when a request sets `detailed: true` (exactly one
 * sentence per request -- see analyzeDetailed). Deliberately NOT part of
 * the bulk/auto-trigger path: this schema's per-item output is far larger,
 * and applying it to a whole multi-sentence chunk is exactly the kind of
 * cost growth that caused the max_tokens truncation bug in the first place.
 */
export interface DetailedBatchItemResult extends BatchItemResult {
  core_pattern: CorePattern | null;
  sentence_structure: SentenceStructure | null;
  structure_components?: StructureComponent[]; // v3
  grammar_points: GrammarPoint[];
  vocabulary: VocabularyItem[];
  common_mistakes: string[];
  similar_expressions: { a: string; b: string; difference: string }[];
  example_sentences: { fr: string; ko: string }[];
}

export interface AiBatchChunkResult {
  sentences: string[];
  status: 'success' | 'failed';
  results?: BatchItemResult[];
  error?: string;
}

export function chunkSentences(sentences: string[], size: number = CHUNK_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < sentences.length; i += size) {
    chunks.push(sentences.slice(i, i + size));
  }
  return chunks;
}

/**
 * Calls the analyze-batch Edge Function for exactly one chunk. Never
 * throws -- any failure (network, rejected by the server, malformed
 * response, result-count mismatch) comes back as status: 'failed' so the
 * caller can keep going with the rest of the chunks.
 */
export async function analyzeChunk(sentences: string[]): Promise<AiBatchChunkResult> {
  try {
    const { data, error, response } = await supabase.functions.invoke('analyze-batch', { body: { sentences } });
    if (error) {
      return { sentences, status: 'failed', error: await describeInvokeError(response) };
    }
    if (!data?.ok || !Array.isArray(data.results)) {
      return { sentences, status: 'failed', error: data?.error ?? 'invalid_response' };
    }
    if (data.results.length !== sentences.length) {
      return { sentences, status: 'failed', error: 'result_count_mismatch' };
    }
    return { sentences, status: 'success', results: data.results as BatchItemResult[] };
  } catch (err) {
    return { sentences, status: 'failed', error: err instanceof Error ? err.message : 'unknown_error' };
  }
}

export interface DetailedAnalysisResult {
  status: 'success' | 'failed';
  result?: DetailedBatchItemResult;
  error?: string;
}

/**
 * The rich per-expression analysis (sentence structure, grammar points,
 * vocabulary, confusable-expression comparisons, 2 fresh examples) used by
 * the expression detail screen. Always exactly ONE sentence -- the server
 * rejects more than that for `detailed: true` (see analyze-batch's
 * MAX_DETAILED_SENTENCES), so this never needs chunking/retry-by-splitting
 * the way the bulk path does.
 */
export async function analyzeDetailed(expressionFr: string): Promise<DetailedAnalysisResult> {
  try {
    const { data, error, response } = await supabase.functions.invoke('analyze-batch', {
      body: { sentences: [expressionFr], detailed: true },
    });
    if (error) {
      return { status: 'failed', error: await describeInvokeError(response) };
    }
    if (!data?.ok || !Array.isArray(data.results) || data.results.length !== 1) {
      return { status: 'failed', error: data?.error ?? 'invalid_response' };
    }
    return { status: 'success', result: data.results[0] as DetailedBatchItemResult };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'unknown_error' };
  }
}

/**
 * supabase-js's invoke() error.message is always the generic "Edge Function
 * returned a non-2xx status code" -- the ACTUAL status code and response
 * body only live on the separate `response` field it returns alongside
 * `error` (see @supabase/functions-js FunctionsClient.invoke, which throws
 * FunctionsHttpError(response) and then unwraps response back out of
 * error.context for this exact purpose). This reads the real status/body so
 * a 401/429/500/etc. shows up as something a user or developer can act on,
 * instead of the one generic sentence every failure used to show.
 */
async function describeInvokeError(response: Response | undefined): Promise<string> {
  if (!response) return 'network_error (no response reached the server)';
  let bodyText = '';
  try {
    const cloned = response.clone();
    const contentType = cloned.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = await cloned.json();
      bodyText = typeof body === 'string' ? body : body?.message ?? body?.error ?? JSON.stringify(body);
    } else {
      bodyText = (await cloned.text()).slice(0, 300);
    }
  } catch {
    bodyText = '(response body could not be read)';
  }
  // Defensive: never surface anything that looks like a secret key, even
  // though this app's Edge Functions never put one in a response body.
  const redacted = bodyText.replace(/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]');
  return `HTTP ${response.status}: ${redacted}`;
}

/**
 * Retries ONLY an `output_truncated` failure (the model's response got cut
 * off mid-JSON) by splitting the chunk in half and trying each half
 * independently -- a smaller chunk needs less output, so it's more likely
 * to finish within budget. Bounded to MAX_SPLIT_RETRY_DEPTH splits so this
 * can never loop forever. Every OTHER failure (401/403/429, network error,
 * result-count mismatch, a truncation that still doesn't fit even at
 * depth 1) is returned as-is with NO retry -- retrying an auth or rate
 * limit error endlessly would never succeed and only wastes calls.
 * Returns a flat list because a split can resolve to a mix of successful
 * and still-failed sub-chunks.
 */
export async function analyzeChunkWithRetry(sentences: string[], depth = 0): Promise<AiBatchChunkResult[]> {
  const result = await analyzeChunk(sentences);
  if (result.status === 'success') return [result];

  const isTruncation = result.error?.includes('output_truncated') ?? false;
  if (!isTruncation || sentences.length <= 1 || depth >= MAX_SPLIT_RETRY_DEPTH) {
    return [result];
  }

  const mid = Math.ceil(sentences.length / 2);
  const [firstHalf, secondHalf] = await Promise.all([
    analyzeChunkWithRetry(sentences.slice(0, mid), depth + 1),
    analyzeChunkWithRetry(sentences.slice(mid), depth + 1),
  ]);
  return [...firstHalf, ...secondHalf];
}

/**
 * Analyzes every sentence by splitting into CHUNK_SIZE-sized chunks and
 * calling analyze-batch sequentially (so the per-user concurrency-1 lock
 * never fights itself, and progress can be reported after each chunk).
 * A failed chunk does not stop the remaining chunks from being attempted.
 */
export async function analyzeSentencesInChunks(
  sentences: string[],
  onProgress?: (done: number, total: number) => void
): Promise<AiBatchChunkResult[]> {
  const chunks = chunkSentences(sentences);
  const chunkResults: AiBatchChunkResult[] = [];
  let done = 0;

  for (const chunk of chunks) {
    const results = await analyzeChunkWithRetry(chunk);
    chunkResults.push(...results);
    done += chunk.length;
    onProgress?.(done, sentences.length);
  }

  return chunkResults;
}

/** Flattens every sentence from the failed chunks of a previous run -- the
 * input to a "실패 항목만 재분석" retry pass. */
export function failedSentencesFrom(chunkResults: AiBatchChunkResult[]): string[] {
  return chunkResults.filter((c) => c.status === 'failed').flatMap((c) => c.sentences);
}
