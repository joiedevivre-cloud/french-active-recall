import { supabase } from '@/lib/supabase';

export const CHUNK_SIZE = 15;

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
    const result = await analyzeChunk(chunk);
    chunkResults.push(result);
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
