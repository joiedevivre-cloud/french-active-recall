import { supabase } from '@/lib/supabase';

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

export interface SeedDictionaryOutcome {
  status: 'success' | 'failed';
  senseCount?: number;
  error?: string;
}

/** Generates a lemma's main dictionary senses up front (separate AI task from analyzeLemmaBatch's per-sentence classification). Never throws. */
export async function seedLemmaDictionary(lemmaId: string): Promise<SeedDictionaryOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke('analyze-lemma', { body: { action: 'seed_dictionary', lemmaId } });
    if (error || !data?.ok) {
      return { status: 'failed', error: data?.error ?? error?.message ?? 'invalid_response' };
    }
    return { status: 'success', senseCount: data.senseCount };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'unknown_error' };
  }
}
