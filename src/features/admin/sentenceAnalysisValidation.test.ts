import { describe, expect, it } from 'vitest';
import { validateSentenceAnalysis } from '../../../supabase/functions/_shared/sentenceAnalysisValidation';
import { hasReflexiveMettre, isReflexiveMettreMisassigned } from '../../../supabase/functions/_shared/lemmaMatching';

// MOCKED AI outputs -- these test the validator, not the real model.

function output(overrides: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return {
    lemma: 'mettre',
    part_of_speech: 'verbe',
    pronunciation_ipa: '/mɛtʁ/',
    grammar_notes: { conjugation_present: 'je mets', past_participle: 'mis', auxiliary: 'avoir', common_mistakes: [] },
    usage: { existing_usage_id: null, label: '~하기 시작하다', meaning_ko: '시작하다', pattern: 'se mettre à + infinitif', ...usage },
    sentence_pronunciation: { pronunciation_ipa: '/ʒə mə sɥi miz a ʃɛʁʃe/', pronunciation_note: '' },
    grammar_points: [{ form: 'passé composé + être', meaning: '대명동사는 être', example: 'Elle s’est mise à rire.' }],
    level: 'B1',
    ...overrides,
  };
}

const SENTENCE = 'Je me suis mise à chercher un nouvel emploi.';

describe('validateSentenceAnalysis', () => {
  it('passes a well-formed, correct analysis', () => {
    expect(validateSentenceAnalysis(output(), { sentence: SENTENCE, existingUsageIds: [] })).toEqual([]);
  });

  it('REGRESSION: reflexive "se mettre à" assigned to a basic-meaning usage fails', () => {
    const errors = validateSentenceAnalysis(output({}, { label: '기기를 켜다', pattern: 'mettre en marche' }), { sentence: SENTENCE, existingUsageIds: [] });
    expect(errors.some((e) => e.includes('reflexive'))).toBe(true);
  });

  it('test-case expectation pattern_includes is enforced', () => {
    const ctx = { sentence: SENTENCE, existingUsageIds: [], expectations: { pattern_includes: 'se mettre à' } };
    expect(validateSentenceAnalysis(output(), ctx)).toEqual([]);
    expect(validateSentenceAnalysis(output({}, { pattern: 'se mettre + groupe nominal' }), ctx).some((e) => e.includes('expected to include'))).toBe(true);
  });

  it('rejects Korean transliteration or non-IPA pronunciation', () => {
    expect(validateSentenceAnalysis(output({ pronunciation_ipa: '메트르' }), { sentence: SENTENCE, existingUsageIds: [] })).toEqual(
      expect.arrayContaining(['pronunciation_ipa: not wrapped in /…/', 'pronunciation_ipa: contains Korean transliteration'])
    );
  });

  it('rejects an existing_usage_id the model was not given', () => {
    const errors = validateSentenceAnalysis(output({}, { existing_usage_id: 'made-up' }), { sentence: SENTENCE, existingUsageIds: ['u1'] });
    expect(errors).toContain('usage.existing_usage_id: not one of the provided usages');
  });

  it('enforces grammar_points 1-3 and the level enum', () => {
    const errors = validateSentenceAnalysis(output({ grammar_points: [], level: 'C1' }), { sentence: SENTENCE, existingUsageIds: [] });
    expect(errors).toEqual(expect.arrayContaining(['grammar_points: must be 1-3 items', 'level: must be A1/A2/B1/B2']));
  });

  it('a non-mettre sentence is not affected by the mettre rule', () => {
    const o = output({ lemma: 'avoir' }, { label: '가지다', pattern: 'avoir + groupe nominal' });
    expect(validateSentenceAnalysis(o, { sentence: 'Vous avez les amis ici ?', existingUsageIds: [] })).toEqual([]);
  });
});

describe('hasReflexiveMettre', () => {
  it.each([
    ['Je me suis mise à chercher un nouvel emploi.', true],
    ['Je me mets au travail.', true],
    ['Il se met à pleuvoir.', true],
    ["Elle s'est mise en colère.", true],
    ['Nous nous mettons au travail.', true],
    ['Vous vous êtes mis d’accord ?', true],
    ['Tu te mets où ?', true],
    ['Je ne me suis pas mise à courir.', true],
    ['Mets-toi là.', true],
    ['Il faut mettre en place une réforme.', false],
    ['Où as-tu mis les clés ?', false],
    ["N'oublie pas de mettre tes gants !", false],
    ['Je mets toujours la radio quand je conduis.', false],
    ['Il me met en colère.', false], // object pronoun, not reflexive
    ['Je te mets au courant.', false], // object pronoun, not reflexive
    ['Nous mettons la table.', false], // subject "nous" only
    ['Vous avez les amis ici ?', false],
  ])('%s -> %s', (sentence, expected) => {
    expect(hasReflexiveMettre(sentence)).toBe(expected);
  });

  it('isReflexiveMettreMisassigned only fires for a non-"se mettre" pattern', () => {
    expect(isReflexiveMettreMisassigned('Je me mets au travail.', 'mettre', 'mettre + groupe nominal')).toBe(true);
    expect(isReflexiveMettreMisassigned('Je me mets au travail.', 'mettre', 'se mettre au travail')).toBe(false);
    expect(isReflexiveMettreMisassigned('Je me mets au travail.', 'travail', 'au travail')).toBe(false);
  });
});
