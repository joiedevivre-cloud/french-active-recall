import { describe, expect, it } from 'vitest';
import { calqueReason, canonicalizePattern } from '../../../supabase/functions/_shared/patternNotation';

describe('canonicalizePattern (standard qqn / qqch / inf. notation)', () => {
  it('the two spellings that duplicated confier now canonicalize identically', () => {
    expect(canonicalizePattern('se confier à + groupe nominal (personne)')).toBe('se confier à qqn');
    expect(canonicalizePattern('se confier à + nom (사람)')).toBe('se confier à qqn');
  });

  it('person / thing / infinitive / clause slots', () => {
    expect(canonicalizePattern('confier + nom + à + nom (사람)')).toBe('confier qqch à qqn');
    expect(canonicalizePattern('confier à + nom (사람) de + infinitif (행동)')).toBe('confier à qqn de + inf.');
    expect(canonicalizePattern('se mettre à + infinitif')).toBe('se mettre à + inf.');
    expect(canonicalizePattern('continuer à + infinitif')).toBe('continuer à + inf.');
    expect(canonicalizePattern('penser à + groupe nominal (personne)')).toBe('penser à qqn');
    expect(canonicalizePattern('sembler + que + 주어 + 동사')).toBe('sembler que + proposition');
    expect(canonicalizePattern("confier quelque chose à quelqu'un")).toBe('confier qqch à qqn');
    expect(canonicalizePattern('confier + nom (사람) avec + nom (사물)')).toBe('confier qqn avec qqch');
  });

  it('keeps meaningful qualifiers and real French words untouched', () => {
    expect(canonicalizePattern('chercher + groupe nominal (emploi)')).toBe('chercher qqch (emploi)');
    expect(canonicalizePattern('mettre + groupe nominal (vêtement)')).toBe('mettre qqch (vêtement)');
    expect(canonicalizePattern('agir au nom de qqn')).toBe('agir au nom de qqn');
    expect(canonicalizePattern('mettre en marche')).toBe('mettre en marche');
  });

  it('is idempotent', () => {
    for (const p of ['confier qqch à qqn', 'se mettre à + inf.', 'chercher qqch (emploi)', 'sembler que + proposition']) {
      expect(canonicalizePattern(canonicalizePattern(p))).toBe(canonicalizePattern(p));
      expect(canonicalizePattern(p)).toBe(p);
    }
  });
});

describe('calqueReason (code guard behind the AI self-check)', () => {
  it('blocks the English "entrust A with B" calque', () => {
    expect(calqueReason(canonicalizePattern('confier + nom (사람) avec + nom (사물)'))).not.toBeNull();
  });
  it('lets real constructions through', () => {
    expect(calqueReason('confier qqch à qqn')).toBeNull();
    expect(calqueReason('se confier à qqn')).toBeNull();
  });
});
