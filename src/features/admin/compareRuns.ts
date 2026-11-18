// Pure helpers for the /admin/prompts test & compare screen.

export interface PromptTestRun {
  id: string;
  version_id: string;
  test_case_id: string | null;
  input_sentence: string;
  output: unknown;
  valid: boolean;
  error: string | null;
  model: string | null;
  created_at: string;
}

export interface AnalysisSummary {
  lemma: string;
  usageLabel: string;
  pattern: string;
  sentenceIpa: string;
  grammarPoints: string;
  level: string;
}

export const COMPARE_FIELDS: { key: keyof AnalysisSummary; label: string }[] = [
  { key: 'lemma', label: 'lemma' },
  { key: 'usageLabel', label: '쓰임 라벨' },
  { key: 'pattern', label: 'pattern' },
  { key: 'sentenceIpa', label: '발음 (IPA)' },
  { key: 'grammarPoints', label: '문법 포인트' },
  { key: 'level', label: '레벨' },
];

export function summarizeOutput(output: unknown): AnalysisSummary | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, any>;
  return {
    lemma: String(o.lemma ?? ''),
    usageLabel: String(o.usage?.label ?? ''),
    pattern: String(o.usage?.pattern ?? ''),
    sentenceIpa: String(o.sentence_pronunciation?.pronunciation_ipa ?? ''),
    grammarPoints: Array.isArray(o.grammar_points) ? o.grammar_points.map((g: any) => g?.form ?? '').join(' / ') : '',
    level: String(o.level ?? ''),
  };
}

/** Key a run by its test case, or by its sentence for a custom (typed-in) sentence. */
export function runKey(run: Pick<PromptTestRun, 'test_case_id' | 'input_sentence'>): string {
  return run.test_case_id ?? `custom:${run.input_sentence.trim()}`;
}

/** Latest run per key (runs may arrive in any order). Optionally only runs at/after `sinceIso`. */
export function latestRuns(runs: PromptTestRun[], sinceIso?: string | null): Map<string, PromptTestRun> {
  const since = sinceIso ? Date.parse(sinceIso) : null;
  const map = new Map<string, PromptTestRun>();
  for (const run of runs) {
    if (since !== null && Date.parse(run.created_at) < since) continue;
    const key = runKey(run);
    const prev = map.get(key);
    if (!prev || Date.parse(run.created_at) > Date.parse(prev.created_at)) map.set(key, run);
  }
  return map;
}

export interface FieldComparison {
  key: keyof AnalysisSummary;
  label: string;
  a: string;
  b: string;
  changed: boolean;
}

export function compareOutputs(a: unknown, b: unknown): FieldComparison[] {
  const sa = summarizeOutput(a);
  const sb = summarizeOutput(b);
  return COMPARE_FIELDS.map(({ key, label }) => {
    const va = sa?.[key] ?? '';
    const vb = sb?.[key] ?? '';
    return { key, label, a: va, b: vb, changed: !!sa && !!sb && va.trim() !== vb.trim() };
  });
}

export interface CompareSummary {
  total: number;
  passA: number;
  passB: number;
  ranA: number;
  ranB: number;
  usageLabelChanged: number;
}

export function compareSummary(keys: string[], runsA: Map<string, PromptTestRun>, runsB: Map<string, PromptTestRun>): CompareSummary {
  let passA = 0, passB = 0, ranA = 0, ranB = 0, usageLabelChanged = 0;
  for (const key of keys) {
    const a = runsA.get(key);
    const b = runsB.get(key);
    if (a) { ranA++; if (a.valid) passA++; }
    if (b) { ranB++; if (b.valid) passB++; }
    if (a && b) {
      const la = summarizeOutput(a.output)?.usageLabel ?? '';
      const lb = summarizeOutput(b.output)?.usageLabel ?? '';
      if (la && lb && la.trim() !== lb.trim()) usageLabelChanged++;
    }
  }
  return { total: keys.length, passA, passB, ranA, ranB, usageLabelChanged };
}

/**
 * Mirrors activate_prompt_version's gate (migration 0018) for the UI: every
 * test case's LATEST run for this draft must be valid and not older than
 * the draft's last edit. The DB function is the real enforcement.
 */
export function activationGate(testCaseIds: string[], runs: PromptTestRun[], draftUpdatedAt: string) {
  const since = Date.parse(draftUpdatedAt);
  const latest = latestRuns(runs.filter((r) => r.test_case_id));
  let passed = 0;
  for (const id of testCaseIds) {
    const run = latest.get(id);
    if (run && run.valid && Date.parse(run.created_at) >= since) passed++;
  }
  return { passed, total: testCaseIds.length, ready: testCaseIds.length > 0 && passed === testCaseIds.length };
}
