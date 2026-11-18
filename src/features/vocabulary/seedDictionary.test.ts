import { describe, expect, it } from 'vitest';
import {
  SEED_MAX_SENSES,
  mergeExamples,
  prepareSeedSenses,
  sanitizeSense,
  type SeedSense,
  type SeedVerdict,
} from '../../../supabase/functions/_shared/prompts/seedDictionary';

// Senses shaped like what gpt-4o-mini actually returned for "confier"
// (remote DB, 2026-11-18), patterns in the old free-form notation.
const sense = (label: string, pattern: string, fr = `Exemple ${label}.`): SeedSense => ({
  label,
  meaning_ko: label,
  pattern,
  required_complement: 'nom',
  mood_requirement: 'none',
  grammar_explanation_ko: '',
  common_mistakes_ko: [],
  examples: [{ fr, ko: label }],
});
const generated: SeedSense[] = [
  sense('맡기다', 'confier + nom + à + nom (사람)', 'Je lui confie mon projet.'),
  sense('위임하다', 'confier à + nom (사람) de + infinitif (행동)'),
  sense('누군가에게 비밀을 털어놓다', 'confier un secret à + nom (사람)', 'Je lui confie un secret.'),
  sense('의탁하다', 'se confier à + nom (사람)', 'Je me confie à mon ami.'),
  sense('신뢰하다', 'confier + nom (사람) avec + nom (사물)'),
];
const existing = [{ id: 'U-learned', label: '비밀을 털어놓다', pattern: 'se confier à + groupe nominal (personne)' }];
const keepAll = (s: SeedSense[]): SeedVerdict[] =>
  s.map((x, index) => ({ index, verdict: 'keep', label: x.label, meaning_ko: x.meaning_ko, pattern: x.pattern, examples: x.examples, reason_ko: '' }));

describe('prepareSeedSenses (code rules behind the AI self-check)', () => {
  it('the old "의탁하다" duplicate now merges into the learned usage instead of a new one', () => {
    const { accepted } = prepareSeedSenses(generated, keepAll(generated), existing);
    const se = accepted.find((a) => a.pattern === 'se confier à qqn')!;
    expect(se.mergeTargetId).toBe('U-learned');
    expect(se.mergeTargetLabel).toBe('비밀을 털어놓다');
  });

  it('blocks the English calque even when the self-check kept it', () => {
    const { accepted, rejected } = prepareSeedSenses(generated, keepAll(generated), existing);
    expect(accepted.some((a) => a.pattern.includes('avec'))).toBe(false);
    expect(rejected.find((r) => r.label === '신뢰하다')?.reason_ko).toMatch(/영어식/);
  });

  it('stores patterns in standard notation', () => {
    const { accepted } = prepareSeedSenses(generated, keepAll(generated), existing);
    expect(accepted.map((a) => a.pattern)).toEqual([
      'confier qqch à qqn',
      'confier à qqn de + inf.',
      'confier un secret à qqn',
      'se confier à qqn',
    ]);
  });

  it('applies drop / fix verdicts from the self-check', () => {
    const verdicts = keepAll(generated);
    verdicts[2] = { ...verdicts[2], verdict: 'drop', reason_ko: '"맡기다"와 같은 구문이에요.' };
    verdicts[1] = {
      ...verdicts[1],
      verdict: 'fix',
      pattern: 'confier à qqn le soin de + inf.',
      examples: [{ fr: "Je lui confie le soin de gérer l'équipe.", ko: '그에게 팀 관리를 맡긴다.' }],
      reason_ko: '자연스러운 형태로 고쳤어요.',
    };
    const { accepted, rejected } = prepareSeedSenses(generated, verdicts, existing);
    const fixed = accepted.find((a) => a.label === '위임하다')!;
    expect(fixed.pattern).toBe('confier à qqn le soin de + inf.');
    expect(fixed.checked).toBe('fix');
    expect(rejected.map((r) => r.label)).toContain('누군가에게 비밀을 털어놓다');
  });

  it('two senses with the same construction -> one usage with both examples', () => {
    const dupes = [sense('맡기다', 'confier qqch à qqn', 'Je lui confie mes clés.'), sense('털어놓다', 'confier + nom (chose) + à + nom (사람)', 'Je lui confie un secret.')];
    const { accepted, rejected } = prepareSeedSenses(dupes, null, []);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].examples.map((e) => e.fr)).toEqual(['Je lui confie mes clés.', 'Je lui confie un secret.']);
    expect(rejected[0].reason_ko).toMatch(/같은 구문/);
  });

  it(`at most ${SEED_MAX_SENSES} usages, a usage without examples is rejected, missing verdict fails closed`, () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((x) => sense(x, `verbe ${x} qqch`));
    expect(prepareSeedSenses(many, null, []).accepted).toHaveLength(SEED_MAX_SENSES);
    expect(prepareSeedSenses([{ ...sense('x', 'faire qqch'), examples: [] }], null, []).accepted).toHaveLength(0);
    expect(prepareSeedSenses([sense('x', 'faire qqch')], [], []).accepted).toHaveLength(0);
  });
});

describe('sanitizeSense / mergeExamples (apply body is client input)', () => {
  it('rejects missing label/pattern and coerces enums', () => {
    expect(sanitizeSense({ label: '', pattern: 'x' })).toBeNull();
    expect(sanitizeSense({ label: 'a', pattern: 'p', required_complement: 'bogus', mood_requirement: 'bogus' })).toMatchObject({ required_complement: 'nom', mood_requirement: 'none', examples: [] });
  });
  it('appends new examples to existing ones without duplicates', () => {
    expect(mergeExamples([{ fr: 'A', ko: 'a' }], [{ fr: 'A', ko: 'a' }, { fr: 'B', ko: 'b' }]).map((e) => e.fr)).toEqual(['A', 'B']);
    expect(mergeExamples(null, [{ fr: 'B', ko: 'b' }])).toHaveLength(1);
  });
});
