import { describe, expect, it } from 'vitest';
import {
  SEED_MAX_CANDIDATES,
  grammarTermsFor,
  looseKey,
  patternHasLemma,
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
  tier: 'core',
  required_complement: 'nom',
  mood_requirement: 'none',
  mood_note_ko: '',
  contrast_ko: '',
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
  s.map((x, index) => ({ index, verdict: 'keep', label: x.label, meaning_ko: x.meaning_ko, pattern: x.pattern, tier: x.tier, examples: x.examples, reason_ko: '' }));

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

  it('no learning limit: every valid construction is kept, core before extra; safety cap lists what it cut', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((x, i) => ({ ...sense(x, `verbe ${x} qqch`), tier: (i === 0 ? 'extra' : 'core') as 'core' | 'extra' }));
    const { accepted } = prepareSeedSenses(five, null, []);
    expect(accepted).toHaveLength(5);
    expect(accepted[accepted.length - 1].label).toBe('a'); // extra goes last
    const many = Array.from({ length: SEED_MAX_CANDIDATES + 2 }, (_, i) => sense(`s${i}`, `verbe${i} qqch`));
    const capped = prepareSeedSenses(many, null, []);
    expect(capped.accepted).toHaveLength(SEED_MAX_CANDIDATES);
    expect(capped.rejected).toHaveLength(2);
  });

  it('constructions the self-check reports as missing are offered and marked', () => {
    const gen = [sense('생각하다', 'penser à qqch', 'Je pense à mes vacances.')];
    const missing = [sense('평가하다', 'penser de qqch', 'Que penses-tu de ce film ?')];
    const { accepted } = prepareSeedSenses([...gen, ...missing], keepAll(gen), [], { missingFromIndex: 1 });
    expect(accepted.map((a) => [a.pattern, a.checked])).toEqual([
      ['penser à qqch', 'keep'],
      ['penser de qqch', 'added'],
    ]);
  });

  it('qqn/qqch-only difference -> suggested, merged only when the learner chose it', () => {
    const ex = [{ id: 'U-qqn', label: '생각하다', pattern: 'penser à qqn' }];
    const s1 = [sense('생각하다', 'penser à qqch', 'Je pense à mes vacances.')];
    const suggested = prepareSeedSenses(s1, null, ex).accepted[0];
    expect(suggested.mergeTargetId).toBeNull();
    expect(suggested.similarTargetId).toBe('U-qqn');
    const chosen = prepareSeedSenses(s1, null, ex, { chosenMerges: ['U-qqn'] }).accepted[0];
    expect(chosen.mergeTargetId).toBe('U-qqn');
    // a forged merge target (not similar) is ignored
    expect(prepareSeedSenses(s1, null, [{ id: 'U-x', label: 'x', pattern: 'penser que + proposition' }], { chosenMerges: ['U-x'] }).accepted[0].mergeTargetId).toBeNull();
    expect(looseKey('penser à qqn/qqch')).toBe(looseKey('penser à qqn'));
    expect(looseKey('penser de qqch')).not.toBe(looseKey('penser à qqch'));
  });

  it('a usage without examples is rejected; a missing verdict fails closed', () => {
    expect(prepareSeedSenses([{ ...sense('x', 'faire qqch'), examples: [] }], null, []).accepted).toHaveLength(0);
    expect(prepareSeedSenses([sense('x', 'faire qqch')], [], []).accepted).toHaveLength(0);
  });
});

describe('patternHasLemma (another word construction never leaks in)', () => {
  it('rejects a pattern without the lemma, keeps pronominal and accented forms', () => {
    expect(patternHasLemma('tenir à qqn/qqch', 'penser')).toBe(false);
    expect(patternHasLemma('penser de qqch', 'penser')).toBe(true);
    expect(patternHasLemma('se confier à qqn', 'confier')).toBe(true);
    expect(patternHasLemma("s'occuper de qqn", 'occuper')).toBe(true);
    expect(patternHasLemma('préférer + inf.', 'preferer')).toBe(true);
    const { accepted, rejected } = prepareSeedSenses([sense('아끼다', 'tenir à qqn/qqch')], null, [], { lemma: 'penser' });
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason_ko).toMatch(/다른 단어/);
  });
});

describe('grammarTermsFor (French terms on each usage card, from the pattern)', () => {
  it('names prepositions, infinitive, completive clause and mood', () => {
    expect(grammarTermsFor('penser de qqch', 'none')).toEqual(['préposition de']);
    expect(grammarTermsFor('penser à + inf.', 'none')).toEqual(['préposition à', 'infinitif']);
    expect(grammarTermsFor('penser que + proposition', 'indicatif')).toEqual(['proposition subordonnée complétive', 'indicatif']);
    expect(grammarTermsFor('confier qqch à qqn', 'none')).toEqual(["complément d'objet direct", 'préposition à', "complément d'objet indirect"]);
    expect(grammarTermsFor('se confier à qqn', 'none')).toEqual(['verbe pronominal', 'préposition à', "complément d'objet indirect"]);
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
