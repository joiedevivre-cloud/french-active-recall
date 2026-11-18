import { supabase } from '@/lib/supabase';
import type { PreparedSense, RejectedSense } from '../../../supabase/functions/_shared/prompts/seedDictionary';

export type { PreparedSense, RejectedSense };

const MAX_IDS_PER_CALL = 20;

export interface LemmaAnalysisResultItem {
  expression_id: string;
  status: 'success' | 'cached' | 'failed';
  lemma_id?: string;
  usage_id?: string;
  error?: string;
}

export interface LemmaAnalysisOutcome {
  status: 'success' | 'failed';
  results?: LemmaAnalysisResultItem[];
  error?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Calls analyze-lemma for up to MAX_IDS_PER_CALL ids at a time. Never throws. */
export async function analyzeLemmaBatch(expressionIds: string[], force = false): Promise<LemmaAnalysisOutcome> {
  if (expressionIds.length === 0) return { status: 'success', results: [] };
  try {
    const results: LemmaAnalysisResultItem[] = [];
    for (const group of chunk(expressionIds, MAX_IDS_PER_CALL)) {
      const { data, error } = await supabase.functions.invoke('analyze-lemma', { body: { expressionIds: group, force } });
      if (error || !data?.ok) {
        return { status: 'failed', error: data?.error ?? error?.message ?? 'invalid_response' };
      }
      results.push(...(data.results ?? []));
    }
    return { status: 'success', results };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'unknown_error' };
  }
}


export interface SeedPreview {
  senses: PreparedSense[];
  rejected: RejectedSense[];
  models?: { generate: string; verify: string };
}

function invokeError(data: { error?: string; message?: string } | null, error: { message?: string } | null): Error {
  return new Error(data?.message ?? data?.error ?? error?.message ?? 'invalid_response');
}

/**
 * "사전 쓰임 추가 (AI)" step 1: generate + strong-model self-check on the
 * server. Nothing is saved -- the learner picks what to keep.
 */
export async function previewSeedDictionary(lemmaId: string): Promise<SeedPreview> {
  const { data, error } = await supabase.functions.invoke('analyze-lemma', { body: { action: 'seed_dictionary', mode: 'preview', lemmaId } });
  if (error || !data?.ok) throw invokeError(data, error);
  return { senses: data.senses ?? [], rejected: data.rejected ?? [], models: data.models };
}

/** Step 2: save the picked senses (server re-runs the code rules; no AI call). */
export async function applySeedDictionary(lemmaId: string, senses: PreparedSense[]): Promise<{ usageIds: string[]; rejected: RejectedSense[] }> {
  const { data, error } = await supabase.functions.invoke('analyze-lemma', { body: { action: 'seed_dictionary', mode: 'apply', lemmaId, senses } });
  if (error || !data?.ok) throw invokeError(data, error);
  return { usageIds: data.usageIds ?? [], rejected: data.rejected ?? [] };
}
