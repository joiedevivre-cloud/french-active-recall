import { describe, expect, it } from 'vitest';
import { guardDetailedResult } from '@/features/ai-batch/detailedAnalysisGuard';
import type { DetailedBatchItemResult, GrammarPoint, VocabularyItem } from '@/features/ai-batch/aiBatchClient';

// MOCKED AI output (hand-written fixtures shaped like detailed-v3) -- these
// test the deterministic guard, not real OpenAI quality. Real-model results
// for the same 6 sentences are a manual check (README "수동 검증").

function base(expression_fr: string, overrides: Partial<DetailedBatchItemResult> = {}): DetailedBatchItemResult {
  return {
    expression_fr,
    corrected_fr: null,
    meaning_ko: '',
    grammar_note: '',
    example_fr: '',
    example_translation_ko: '',
    cefr_level: 'B1',
    tags: [],
    key_phrase: '',
    core_pattern: null,
    sentence_structure: null,
    structure_components: [],
    grammar_points: [],
    vocabulary: [],
    common_mistakes: [],
    similar_expressions: [],
    example_sentences: [],
    ...overrides,
  };
}

function vocab(word: string, sentence_error: string | null, learning_point: string | null = null): VocabularyItem {
  return {
    word,
    part_of_speech: 'nom',
    meaning_ko: '',
    infinitive: null,
    tense_or_conjugation: null,
    gender_agreement: null,
    preposition: null,
    sentence_error,
    learning_point,
  };
}

function gp(overrides: Partial<GrammarPoint>): GrammarPoint {
  return { pattern: '', meaning: '', example: '', ...overrides };
}

describe('guardDetailedResult: no false error warnings on a correct sentence', () => {
  it('REGRESSION 1 (Malgré la fatigue...): drops the fatigue gender + apprendre verb-form "errors"', () => {
    const out = guardDetailedResult(
      base('Malgré la fatigue, je continue à apprendre le français.', {
        vocabulary: [
          vocab('fatigue', 'gender agreement: la → le', '여성 명사: la fatigue'),
          vocab('apprendre', '동사 형태가 잘못됨'),
        ],
      })
    );
    expect(out.vocabulary.map((v) => v.sentence_error)).toEqual([null, null]);
    // the general rule survives as a learning point
    expect(out.vocabulary[0].learning_point).toBe('여성 명사: la fatigue');
  });

  it('keeps a real error when the sentence actually has one (corrected_fr differs)', () => {
    const out = guardDetailedResult(
      base('Malgré je suis fatiguée, je continue.', {
        corrected_fr: 'Malgré la fatigue, je continue.',
        vocabulary: [vocab('malgré', 'malgré는 절을 이끌 수 없음')],
      })
    );
    expect(out.vocabulary[0].sentence_error).toBe('malgré는 절을 이끌 수 없음');
  });

  it('treats corrected_fr identical to the input (punctuation/case aside) as "correct"', () => {
    const out = guardDetailedResult(
      base('Je me suis mise à chercher un nouvel emploi.', {
        corrected_fr: 'je me suis mise à chercher un nouvel emploi',
        vocabulary: [vocab('nouvel', 'nouveau여야 함')],
      })
    );
    expect(out.vocabulary[0].sentence_error).toBeNull();
  });

  it('does not mutate its input', () => {
    const input = base('Il faut que je mette à jour mon profil.', { vocabulary: [vocab('mette', 'wrong')] });
    guardDetailedResult(input);
    expect(input.vocabulary[0].sentence_error).toBe('wrong');
  });
});

describe('guardDetailedResult: construction cards stay self-consistent', () => {
  it('REGRESSION 2 (se rendre compte que): mood stays indicatif for a clause complement', () => {
    const out = guardDetailedResult(
      base('Je me rends compte que je fais des progrès en français.', {
        grammar_points: [gp({ pattern: "se rendre compte que + proposition à l'indicatif", required_complement: 'clause', mood_requirement: 'indicatif' })],
      })
    );
    expect(out.grammar_points[0].mood_requirement).toBe('indicatif');
  });

  it('REGRESSION 3 (se mettre à): a mood on an infinitif complement is forced to none', () => {
    const out = guardDetailedResult(
      base('Je me suis mise à chercher un nouvel emploi.', {
        grammar_points: [gp({ pattern: 'se mettre à + infinitif', required_complement: 'infinitif', mood_requirement: 'subjonctif' })],
      })
    );
    expect(out.grammar_points[0].mood_requirement).toBe('none');
  });

  it('REGRESSION 4 (il faut que): keeps subjonctif and drops an "incorrect example" that is just the correct input', () => {
    const sentence = 'Il faut que je mette à jour mon profil.';
    const out = guardDetailedResult(
      base(sentence, {
        grammar_points: [
          gp({
            pattern: 'il faut que + proposition au subjonctif',
            required_complement: 'clause',
            mood_requirement: 'subjonctif',
            incorrect_example: { fr: sentence, reason_ko: '틀림' },
          }),
        ],
      })
    );
    expect(out.grammar_points[0].mood_requirement).toBe('subjonctif');
    expect(out.grammar_points[0].incorrect_example).toBeNull();
  });

  it('REGRESSION 5 (avoir beau): keeps a genuine incorrect example', () => {
    const out = guardDetailedResult(
      base("J'ai beau étudier, je fais encore des erreurs.", {
        grammar_points: [
          gp({
            pattern: 'avoir beau + infinitif',
            required_complement: 'infinitif',
            mood_requirement: 'none',
            incorrect_example: { fr: "J'ai beau que j'étudie, ...", reason_ko: 'avoir beau 뒤에는 infinitif' },
          }),
        ],
      })
    );
    expect(out.grammar_points[0].incorrect_example?.fr).toBe("J'ai beau que j'étudie, ...");
  });

  it('REGRESSION 6 (avoir du mal à / se confier à): drops an "alternative" identical to the input, keeps real ones and fixes their mood', () => {
    const sentence = 'Elle a du mal à se confier aux autres.';
    const out = guardDetailedResult(
      base(sentence, {
        grammar_points: [
          gp({
            pattern: 'avoir du mal à + infinitif',
            required_complement: 'infinitif',
            mood_requirement: 'none',
            alternatives: [
              {
                expression: 'avoir du mal à',
                construction: 'avoir du mal à + infinitif',
                required_complement: 'infinitif',
                mood_requirement: 'none',
                meaning_ko: '',
                nuance_ko: '',
                register: 'courant',
                rewritten_sentence: sentence,
              },
              {
                expression: 'avoir de la difficulté à',
                construction: 'avoir de la difficulté à + infinitif',
                required_complement: 'infinitif',
                mood_requirement: 'subjonctif',
                meaning_ko: '',
                nuance_ko: '',
                register: 'courant',
                rewritten_sentence: 'Elle a de la difficulté à se confier aux autres.',
              },
            ],
          }),
        ],
      })
    );
    const alts = out.grammar_points[0].alternatives!;
    expect(alts).toHaveLength(1);
    expect(alts[0].expression).toBe('avoir de la difficulté à');
    expect(alts[0].mood_requirement).toBe('none');
  });

  it('leaves legacy (v1/v2) grammar points without the new fields untouched', () => {
    const legacy = gp({ pattern: 'il faut que + subjonctif', meaning: '...', example: '...' });
    const out = guardDetailedResult(base('Il faut que je parte.', { grammar_points: [legacy] }));
    expect(out.grammar_points[0]).toEqual(legacy);
  });
});
