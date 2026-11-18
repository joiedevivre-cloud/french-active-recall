import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAdminUser } from '../../../supabase/functions/_shared/adminAuth';
import { diffLines } from '@/lib/lineDiff';
import { activationGate, compareOutputs, compareSummary, latestRuns, type PromptTestRun } from '@/features/admin/compareRuns';

const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('admin check (server side)', () => {
  it('only app_metadata.role = admin counts', () => {
    expect(isAdminUser({ app_metadata: { role: 'admin' } })).toBe(true);
    expect(isAdminUser({ app_metadata: { role: 'user' } })).toBe(false);
    expect(isAdminUser({ app_metadata: {}, user_metadata: { role: 'admin' } })).toBe(false); // user-editable -> ignored
    expect(isAdminUser(null)).toBe(false);
  });

  it('admin-prompts returns 403 before reading the body or touching any table', () => {
    const src = read('supabase/functions/admin-prompts/index.ts');
    const forbidden = src.indexOf("jsonResponse({ error: 'forbidden'");
    expect(forbidden).toBeGreaterThan(0);
    expect(src.indexOf('await req.json()')).toBeGreaterThan(forbidden);
    expect(src.indexOf('SUPABASE_SERVICE_ROLE_KEY);', src.indexOf('Deno.serve'))).toBeGreaterThan(forbidden);
    expect(src).toContain('403');
  });
});

describe('preview never writes learning data (static check of admin-prompts)', () => {
  const src = read('supabase/functions/admin-prompts/index.ts');
  const LEARNING_TABLES = ['lemmas', 'lemma_usages', 'expression_analysis', 'expressions', 'expression_examples', 'review_states', 'review_attempts', 'usage_examples'];

  it('learning tables are only ever .select()-ed', () => {
    for (const table of LEARNING_TABLES) {
      const re = new RegExp(`\\.from\\('${table}'\\)\\s*\\.(\\w+)\\(`, 'g');
      for (const m of src.matchAll(re)) expect(`${table}.${m[1]}`).toBe(`${table}.select`);
    }
  });

  it('writes go only to prompt_* tables and the AI usage log', () => {
    const writes = [...src.matchAll(/\.from\('(\w+)'\)\s*\.(insert|update|upsert|delete)\(/g)].map((m) => m[1]);
    expect(new Set(writes)).toEqual(new Set(['prompt_versions', 'prompt_test_runs', 'ai_usage_log']));
  });
});

describe('every sentence-analysis AI path uses the shared loader', () => {
  it.each([['supabase/functions/analyze-lemma/index.ts'], ['scripts/backfill-analysis.ts']])('%s', (file) => {
    const src = read(file);
    expect(src).toContain('loadActivePrompt(');
    expect(src).not.toMatch(/\bANALYZE_SYSTEM_PROMPT\b/);
    expect(src).toContain('prompt_version_id');
  });

  it('admin preview builds prompts with the same builder the loader uses', () => {
    expect(read('supabase/functions/admin-prompts/index.ts')).toContain('buildLoadedPrompt(');
  });

  it('analyze-expression is marked deprecated', () => {
    expect(read('supabase/functions/analyze-expression/index.ts').split('\n').slice(0, 3).join('\n')).toContain('DEPRECATED, 사용 안 함');
  });
});

// ---------------------------------------------------------------------------

function run(overrides: Partial<PromptTestRun>): PromptTestRun {
  return {
    id: Math.random().toString(36),
    version_id: 'v',
    test_case_id: 'c1',
    input_sentence: 's',
    output: null,
    valid: true,
    error: null,
    model: 'gpt-4o-mini',
    created_at: '2026-11-18T10:00:00Z',
    ...overrides,
  };
}

const out = (label: string, pattern = 'p') => ({
  lemma: 'mettre',
  usage: { label, pattern },
  sentence_pronunciation: { pronunciation_ipa: '/x/' },
  grammar_points: [{ form: 'f' }],
  level: 'B1',
});

describe('compare / activation gate (UI mirror of the DB gate)', () => {
  it('latestRuns keeps the newest run per test case / custom sentence', () => {
    const runs = [
      run({ created_at: '2026-11-18T10:00:00Z', valid: false }),
      run({ created_at: '2026-11-18T11:00:00Z', valid: true }),
      run({ test_case_id: null, input_sentence: 'Bonjour.' }),
    ];
    const latest = latestRuns(runs);
    expect(latest.get('c1')?.valid).toBe(true);
    expect(latest.has('custom:Bonjour.')).toBe(true);
  });

  it('highlights changed fields and counts usage label changes', () => {
    const fields = compareOutputs(out('놓다'), out('~하기 시작하다', 'se mettre à + infinitif'));
    expect(fields.filter((f) => f.changed).map((f) => f.key)).toEqual(['usageLabel', 'pattern']);
    const a = latestRuns([run({ output: out('놓다') })]);
    const b = latestRuns([run({ output: out('~하기 시작하다'), valid: false })]);
    expect(compareSummary(['c1', 'c2'], a, b)).toEqual({ total: 2, passA: 1, passB: 0, ranA: 1, ranB: 1, usageLabelChanged: 1 });
  });

  it('gate needs every case valid AND run after the last draft edit', () => {
    const runs = [run({ test_case_id: 'c1' }), run({ test_case_id: 'c2', created_at: '2026-11-18T08:00:00Z' })];
    expect(activationGate(['c1', 'c2'], runs, '2026-11-18T09:00:00Z')).toEqual({ passed: 1, total: 2, ready: false });
    expect(activationGate(['c1'], runs, '2026-11-18T09:00:00Z').ready).toBe(true);
    expect(activationGate(['c1'], [run({ valid: false })], '2026-11-18T09:00:00Z').ready).toBe(false);
    expect(activationGate([], [], '2026-11-18T09:00:00Z').ready).toBe(false);
  });
});

describe('diffLines', () => {
  it('marks added and removed lines', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'added', text: 'B' },
      { type: 'same', text: 'c' },
    ]);
    expect(diffLines('x', 'x')).toEqual([{ type: 'same', text: 'x' }]);
  });
});
