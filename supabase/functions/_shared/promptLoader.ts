// THE prompt loader for every AI path that uses the sentence-analysis
// prompt: analyze-lemma (classify), admin-prompts (preview/compare) and
// scripts/backfill-analysis.ts. Reads the ACTIVE prompt_versions row,
// renders its {{variables}}, appends the locked output contract.
//
// - 60 s in-memory cache per prompt_key (per function instance), so an
//   activation reaches every instance within a minute without a DB read on
//   every request.
// - Any failure (DB error, no active row, a stored template that no longer
//   renders) falls back to the code default and logs ONE line with the
//   reason -- never the prompt text or the user's sentence.
//
// Works on Deno and Node: the caller passes its own supabase client.
import { composeSystemPrompt, normalizeSettings, renderInstructions, type PromptSettings } from './promptTemplate.ts';
import {
  ANALYZE_SYSTEM_PROMPT,
  PROMPT_VERSION,
  SENTENCE_ANALYSIS_DEFAULT_INSTRUCTIONS,
  SENTENCE_ANALYSIS_OUTPUT_CONTRACT,
  SENTENCE_ANALYSIS_PROMPT_KEY,
} from './prompts/analyze.ts';

export const PROMPT_CACHE_TTL_MS = 60_000;

export interface LoadedPrompt {
  source: 'db' | 'fallback';
  promptKey: string;
  versionId: string | null;
  versionNo: number | null;
  systemPrompt: string;
  model: string | null;
  temperature: number | null;
  settings: PromptSettings;
  /** written to expression_analysis.prompt_version (the legacy text column) */
  versionLabel: string;
}

export interface PromptVersionRow {
  id: string;
  version_no: number;
  instructions: string;
  settings: unknown;
  model: string | null;
  temperature: number | null;
}

interface PromptRegistryEntry {
  outputContract: string;
  fallbackSystemPrompt: string;
  fallbackLabel: string;
}

// Only 'sentence-analysis' exists today. ('word-analysis' is reserved for a
// future analyze-word function -- intentionally not registered.)
export const PROMPT_REGISTRY: Record<string, PromptRegistryEntry> = {
  [SENTENCE_ANALYSIS_PROMPT_KEY]: {
    outputContract: SENTENCE_ANALYSIS_OUTPUT_CONTRACT,
    fallbackSystemPrompt: ANALYZE_SYSTEM_PROMPT,
    fallbackLabel: `${PROMPT_VERSION}:fallback`,
  },
};

export const DEFAULT_INSTRUCTIONS: Record<string, string> = {
  [SENTENCE_ANALYSIS_PROMPT_KEY]: SENTENCE_ANALYSIS_DEFAULT_INSTRUCTIONS,
};

/** Builds a LoadedPrompt from a version row (also used for previewing a NON-active version). Throws if the template can't render. */
export function buildLoadedPrompt(promptKey: string, row: PromptVersionRow): LoadedPrompt {
  const entry = PROMPT_REGISTRY[promptKey];
  if (!entry) throw new Error(`unknown_prompt_key: ${promptKey}`);
  const settings = normalizeSettings(row.settings);
  return {
    source: 'db',
    promptKey,
    versionId: row.id,
    versionNo: row.version_no,
    systemPrompt: composeSystemPrompt(renderInstructions(row.instructions, settings), entry.outputContract),
    model: row.model,
    temperature: row.temperature === null || row.temperature === undefined ? null : Number(row.temperature),
    settings,
    versionLabel: `${promptKey}:v${row.version_no}`,
  };
}

export function fallbackPrompt(promptKey: string): LoadedPrompt {
  const entry = PROMPT_REGISTRY[promptKey];
  if (!entry) throw new Error(`unknown_prompt_key: ${promptKey}`);
  return {
    source: 'fallback',
    promptKey,
    versionId: null,
    versionNo: null,
    systemPrompt: entry.fallbackSystemPrompt,
    model: null,
    temperature: null,
    settings: normalizeSettings(null),
    versionLabel: entry.fallbackLabel,
  };
}

const cache = new Map<string, { at: number; value: LoadedPrompt }>();

export function clearPromptCache(): void {
  cache.clear();
}

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = { from: (table: string) => any };

export async function loadActivePrompt(client: AnySupabaseClient, promptKey: string, now: number = Date.now()): Promise<LoadedPrompt> {
  const hit = cache.get(promptKey);
  if (hit && now - hit.at < PROMPT_CACHE_TTL_MS) return hit.value;

  let value: LoadedPrompt;
  try {
    const { data, error } = await client
      .from('prompt_versions')
      .select('id, version_no, instructions, settings, model, temperature')
      .eq('prompt_key', promptKey)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw new Error(`db_error: ${error.message}`);
    if (!data) throw new Error('no_active_version');
    value = buildLoadedPrompt(promptKey, data as PromptVersionRow);
  } catch (err) {
    console.warn('[prompt-loader] using code fallback', promptKey, err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    value = fallbackPrompt(promptKey);
  }
  cache.set(promptKey, { at: now, value });
  return value;
}
