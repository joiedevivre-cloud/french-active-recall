import { describe, expect, it } from 'vitest';
import { splitInputIntoRows, inferSourceTypeFromContext } from '@/features/capture/addExpression';

describe('splitInputIntoRows', () => {
  it('keeps a plain expression (no separator) as a single row with no meaning', () => {
    const rows = splitInputIntoRows('relever un défi');
    expect(rows).toEqual([{ expressionFr: 'relever un défi', meaningKo: null, tags: [] }]);
  });

  it('splits a single "fr — ko" line into one row with a meaning', () => {
    const rows = splitInputIntoRows('Je pense à lui. — 나는 그를 생각해.');
    expect(rows).toEqual([{ expressionFr: 'Je pense à lui.', meaningKo: '나는 그를 생각해.', tags: [] }]);
  });

  it('splits multiple lines into multiple rows', () => {
    const text = `Je pense à lui. — 나는 그를 생각해.
Que penses-tu de lui ? — 너는 그에 대해 어떻게 생각해?`;
    const rows = splitInputIntoRows(text);
    expect(rows).toHaveLength(2);
    expect(rows[0].expressionFr).toBe('Je pense à lui.');
    expect(rows[1].expressionFr).toBe('Que penses-tu de lui ?');
  });
});

describe('inferSourceTypeFromContext', () => {
  it('maps common "class" keywords to school', () => {
    expect(inferSourceTypeFromContext('수업', 'manual')).toBe('school');
    expect(inferSourceTypeFromContext('오늘 학교에서', 'manual')).toBe('school');
    expect(inferSourceTypeFromContext('école', 'manual')).toBe('school');
  });

  it('falls back when context does not match', () => {
    expect(inferSourceTypeFromContext('TV5MONDE', 'manual')).toBe('manual');
    expect(inferSourceTypeFromContext(null, 'manual')).toBe('manual');
    expect(inferSourceTypeFromContext('', 'manual')).toBe('manual');
  });
});
