import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROMPT_CACHE_TTL_MS,
  buildLoadedPrompt,
  clearPromptCache,
  loadActivePrompt,
} from '../../../supabase/functions/_shared/promptLoader';
import {
  ANALYZE_SYSTEM_PROMPT,
  SENTENCE_ANALYSIS_DEFAULT_INSTRUCTIONS,
  SENTENCE_ANALYSIS_OUTPUT_CONTRACT,
} from '../../../supabase/functions/_shared/prompts/analyze';

function fakeClient(result: { data: unknown; error: unknown } | (() => never)) {
  const maybeSingle = vi.fn(async () => (typeof result === 'function' ? result() : result));
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = maybeSingle;
  return { client: { from: vi.fn(() => chain) }, maybeSingle };
}

const activeRow = {
  id: 'ver-2',
  version_no: 2,
  instructions: 'Teach at {{target_level}} level.',
  settings: { target_level: 'B2' },
  model: 'gpt-4o-mini',
  temperature: 0.3,
};

beforeEach(() => {
  clearPromptCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('loadActivePrompt (one loader for analyze-lemma, admin preview, backfill)', () => {
  it('uses the active DB version: rendered instructions + locked contract', async () => {
    const { client } = fakeClient({ data: activeRow, error: null });
    const p = await loadActivePrompt(client, 'sentence-analysis', 0);
    expect(p.source).toBe('db');
    expect(p.versionId).toBe('ver-2');
    expect(p.versionLabel).toBe('sentence-analysis:v2');
    expect(p.temperature).toBe(0.3);
    expect(p.systemPrompt).toBe(`Teach at B2 level.\n\n${SENTENCE_ANALYSIS_OUTPUT_CONTRACT.trim()}`);
  });

  it('falls back to the code prompt (and logs) when the DB read fails', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'relation does not exist' } });
    const p = await loadActivePrompt(client, 'sentence-analysis', 0);
    expect(p.source).toBe('fallback');
    expect(p.versionId).toBeNull();
    expect(p.systemPrompt).toBe(ANALYZE_SYSTEM_PROMPT);
    expect(console.warn).toHaveBeenCalledOnce();
    // the log line must not contain prompt text
    expect(JSON.stringify((console.warn as any).mock.calls)).not.toContain('French teacher');
  });

  it('falls back when there is no active version or the stored template cannot render', async () => {
    expect((await loadActivePrompt(fakeClient({ data: null, error: null }).client, 'sentence-analysis', 0)).source).toBe('fallback');
    clearPromptCache();
    const broken = { ...activeRow, instructions: 'uses {{unknown_var}}' };
    expect((await loadActivePrompt(fakeClient({ data: broken, error: null }).client, 'sentence-analysis', 0)).source).toBe('fallback');
  });

  it('falls back when the client throws', async () => {
    const { client } = fakeClient(() => {
      throw new Error('network down');
    });
    expect((await loadActivePrompt(client, 'sentence-analysis', 0)).source).toBe('fallback');
  });

  it('caches for 60 s, then reads again', async () => {
    const { client, maybeSingle } = fakeClient({ data: activeRow, error: null });
    await loadActivePrompt(client, 'sentence-analysis', 1_000);
    await loadActivePrompt(client, 'sentence-analysis', 1_000 + PROMPT_CACHE_TTL_MS - 1);
    expect(maybeSingle).toHaveBeenCalledTimes(1);
    await loadActivePrompt(client, 'sentence-analysis', 1_000 + PROMPT_CACHE_TTL_MS);
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });
});

describe('version 1 seed = the prompt production already ran', () => {
  const sql = readFileSync(resolve(__dirname, '../../../supabase/migrations/0018_prompt_management.sql'), 'utf8');

  it('migration 0018 seeds exactly SENTENCE_ANALYSIS_DEFAULT_INSTRUCTIONS', () => {
    const seeded = sql.match(/\$instr\$([\s\S]*?)\$instr\$/)?.[1];
    expect(seeded).toBe(SENTENCE_ANALYSIS_DEFAULT_INSTRUCTIONS);
  });

  it('v1 loaded from the DB produces the same system prompt as the code fallback', () => {
    const v1 = buildLoadedPrompt('sentence-analysis', {
      id: 'v1',
      version_no: 1,
      instructions: SENTENCE_ANALYSIS_DEFAULT_INSTRUCTIONS,
      settings: {},
      model: 'gpt-4o-mini',
      temperature: null,
    });
    expect(v1.systemPrompt).toBe(ANALYZE_SYSTEM_PROMPT);
    expect(v1.temperature).toBeNull();
  });

  it('seeds the 14-sentence test set including the two added cases', () => {
    expect((sql.match(/\('sentence-analysis', '/g) ?? []).length).toBe(14);
    expect(sql).toContain('Je me suis mise à chercher un nouvel emploi.');
    expect(sql).toContain('"pattern_includes":"se mettre à"');
    expect(sql).toContain('Vous avez les amis ici ?');
  });

  it('does not use the reserved word-analysis key', () => {
    expect(sql).not.toMatch(/'word-analysis'\s*[,)]/);
  });
});
