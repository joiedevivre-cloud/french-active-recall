import { describe, expect, it } from 'vitest';
import {
  complementLabelFr,
  complementLabelKo,
  grammarTagFromPattern,
  koGlossFor,
  posLabel,
  registerLabel,
  termWithGloss,
  toFrenchTerm,
} from '@/lib/grammarTerms';

describe('complementLabelFr (Construction grammaticale: what must follow)', () => {
  it('matches the spec examples', () => {
    expect(complementLabelFr('nom', 'none')).toBe('groupe nominal (GN)'); // malgré
    expect(complementLabelFr('clause', 'indicatif')).toBe("proposition à l'indicatif"); // même si
    expect(complementLabelFr('clause', 'subjonctif')).toBe('proposition au subjonctif'); // bien que
    expect(complementLabelFr('infinitif', 'none')).toBe('infinitif'); // se mettre à
    expect(complementLabelFr('independent', 'none')).toBe('proposition indépendante'); // pourtant
  });

  it('ignores a mood on a non-clause complement', () => {
    expect(complementLabelFr('infinitif', 'subjonctif')).toBe('infinitif');
  });

  it('returns null for missing/unknown values (legacy rows render without the row)', () => {
    expect(complementLabelFr(undefined)).toBeNull();
    expect(complementLabelFr('something_else')).toBeNull();
  });

  it('has Korean glosses for every French label', () => {
    expect(complementLabelKo('nom')).toBe('명사구');
    expect(complementLabelKo('clause', 'subjonctif')).toBe('접속법 절');
    expect(complementLabelKo('clause', 'indicatif')).toBe('직설법 절');
  });
});

describe('legacy Korean term names render as French without re-analysis', () => {
  it('maps Korean grammar names to the French term', () => {
    expect(toFrenchTerm('주절')).toBe('Proposition principale');
    expect(toFrenchTerm('종속절')).toBe('Proposition subordonnée');
    expect(toFrenchTerm('접속법')).toBe('Subjonctif');
    expect(toFrenchTerm('직설법')).toBe('Indicatif');
    expect(toFrenchTerm('명사구')).toBe('Groupe nominal (GN)');
    expect(toFrenchTerm('대명동사')).toBe('Verbe pronominal');
    expect(toFrenchTerm('성·수 일치')).toBe('Accord en genre et en nombre');
    expect(toFrenchTerm('동사원형')).toBe('Infinitif');
  });

  it('normalizes French spelling/case', () => {
    expect(toFrenchTerm('subjonctif')).toBe('Subjonctif');
    expect(toFrenchTerm('PROPOSITION INDEPENDANTE')).toBe('Proposition indépendante');
  });

  it('passes unknown text through unchanged (never loses content)', () => {
    expect(toFrenchTerm('présent de l’indicatif, 1인칭')).toBe('présent de l’indicatif, 1인칭');
    expect(toFrenchTerm('')).toBe('');
    expect(toFrenchTerm(null)).toBe('');
  });

  it('gives Korean glosses for French terms', () => {
    expect(koGlossFor('Subjonctif')).toBe('접속법');
    expect(koGlossFor('verbe pronominal')).toBe('대명동사');
    expect(koGlossFor('not a term')).toBeNull();
    expect(termWithGloss('주절')).toBe('Proposition principale (주절)');
  });
});

describe('posLabel / registerLabel', () => {
  it('shows parts of speech in French', () => {
    expect(posLabel('동사')).toBe('verbe');
    expect(posLabel('형용사')).toBe('adjectif');
    expect(posLabel('nom féminin')).toBe('nom féminin');
  });

  it('labels register in French with a Korean gloss', () => {
    expect(registerLabel('soutenu')).toBe('soutenu (격식)');
    expect(registerLabel('familier')).toBe('familier (구어)');
    expect(registerLabel(null)).toBeNull();
  });
});

describe('grammarTagFromPattern (one grammar_skills row per construction)', () => {
  it('is stable across case, accents and the (GN) annotation', () => {
    expect(grammarTagFromPattern('Se mettre à + infinitif')).toBe('se_mettre_a_infinitif');
    expect(grammarTagFromPattern('se mettre a + Infinitif')).toBe('se_mettre_a_infinitif');
    expect(grammarTagFromPattern('malgré + groupe nominal (GN)')).toBe('malgre_groupe_nominal');
  });

  it('keeps different constructions apart', () => {
    expect(grammarTagFromPattern('bien que + proposition au subjonctif')).not.toBe(grammarTagFromPattern('même si + proposition à l’indicatif'));
  });
});
