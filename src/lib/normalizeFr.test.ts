import { describe, expect, it } from 'vitest';
import { normalizeFr } from '@/lib/normalizeFr';

describe('normalizeFr', () => {
  it('lowercases and trims', () => {
    expect(normalizeFr('  Relever Un Defi  ')).toBe('relever un defi');
  });

  it('strips accents the same way Postgres unaccent() does', () => {
    expect(normalizeFr('Relever un défi')).toBe('relever un defi');
    expect(normalizeFr('déjà vu')).toBe('deja vu');
  });

  it('treats accented and plain forms as duplicates', () => {
    expect(normalizeFr('Relever un défi')).toBe(normalizeFr('relever un defi'));
  });
});
