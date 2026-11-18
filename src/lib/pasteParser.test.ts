import { describe, expect, it } from 'vitest';
import { parsePasteText, markPasteDuplicates, type PasteParsedRow } from '@/lib/pasteParser';
import type { ExistingExpressionLookup } from '@/lib/csvImport';

const USER_EXAMPLE = `Je pense à lui. — 나는 그를 생각해.
* Que penses-tu de lui ? — 너는 그에 대해 어떻게 생각해?
* Pense à l'appeler. — 그에게 전화하는 걸 잊지 마.`;

function newRows(result: { rows: PasteParsedRow[] }) {
  return result.rows.filter((r) => r.status === 'new');
}

describe('parsePasteText - user example', () => {
  it('splits exactly 3 rows without breaking penses-tu', () => {
    const result = parsePasteText(USER_EXAMPLE);
    const rows = newRows(result);
    expect(rows).toHaveLength(3);

    expect(rows[0].expressionFr).toBe('Je pense à lui.');
    expect(rows[0].meaningKo).toBe('나는 그를 생각해.');

    expect(rows[1].expressionFr).toBe('Que penses-tu de lui ?');
    expect(rows[1].meaningKo).toBe('너는 그에 대해 어떻게 생각해?');

    expect(rows[2].expressionFr).toBe("Pense à l'appeler.");
    expect(rows[2].meaningKo).toBe('그에게 전화하는 걸 잊지 마.');

    rows.forEach((r) => expect(r.isSentence).toBe(true));
  });
});

describe('parsePasteText - bullet and list markers', () => {
  const cases: [string, string][] = [
    ['* confier — 맡기다', '*'],
    ['- confier — 맡기다', '-'],
    ['• confier — 맡기다', '•'],
    ['· confier — 맡기다', '·'],
    ['○ confier — 맡기다', '○'],
    ['▪ confier — 맡기다', '▪'],
    ['➤ confier — 맡기다', '➤'],
    ['1. confier — 맡기다', '숫자.'],
    ['2) confier — 맡기다', '숫자)'],
  ];

  it.each(cases)('strips the %s bullet (%s)', (line) => {
    const [row] = newRows(parsePasteText(line));
    expect(row.expressionFr).toBe('confier');
    expect(row.meaningKo).toBe('맡기다');
  });

  it('strips circled-digit bullets', () => {
    const [row] = newRows(parsePasteText('① confier — 맡기다'));
    expect(row.expressionFr).toBe('confier');
    expect(row.meaningKo).toBe('맡기다');
  });

  it('strips markdown bold/code wrapping', () => {
    const [row] = newRows(parsePasteText('**confier** — 맡기다'));
    expect(row.expressionFr).toBe('confier');
    expect(row.meaningKo).toBe('맡기다');

    const [row2] = newRows(parsePasteText('`confier` — 맡기다'));
    expect(row2.expressionFr).toBe('confier');
    expect(row2.meaningKo).toBe('맡기다');
  });
});

describe('parsePasteText - separators', () => {
  const separators = ['—', '–', '-', '|', '→', '=', ':', '\t'];

  it.each(separators)('splits on "%s" when padded with spaces', (sep) => {
    const line = `confier ${sep} 맡기다`;
    const [row] = newRows(parsePasteText(line));
    expect(row.expressionFr).toBe('confier');
    expect(row.meaningKo).toBe('맡기다');
  });

  it('does not split a markdown table row on its outer pipes', () => {
    const [row] = newRows(parsePasteText('| Je pense à lui. | 나는 그를 생각해. |'));
    expect(row.expressionFr).toBe('Je pense à lui.');
    expect(row.meaningKo).toBe('나는 그를 생각해.');
  });

  it('ignores a markdown table divider row', () => {
    const result = parsePasteText('| --- | --- |');
    expect(result.rows).toHaveLength(0);
  });
});

describe('parsePasteText - hyphen/colon must be space-padded to count as separators', () => {
  it('keeps peut-être intact', () => {
    const [row] = newRows(parsePasteText("Peut-être qu'il viendra. — 아마 그가 올 거야."));
    expect(row.expressionFr).toBe("Peut-être qu'il viendra.");
    expect(row.meaningKo).toBe('아마 그가 올 거야.');
  });

  it("keeps Qu'est-ce que intact", () => {
    const [row] = newRows(parsePasteText('Qu\'est-ce que tu veux ? — 뭘 원해?'));
    expect(row.expressionFr).toBe("Qu'est-ce que tu veux ?");
    expect(row.meaningKo).toBe('뭘 원해?');
  });

  it('keeps Est-ce que intact', () => {
    const [row] = newRows(parsePasteText('Est-ce que tu viens ? — 올 거야?'));
    expect(row.expressionFr).toBe('Est-ce que tu viens ?');
    expect(row.meaningKo).toBe('올 거야?');
  });
});

describe('parsePasteText - French-only lines (no Korean)', () => {
  it('saves expression_fr only, meaning_ko empty', () => {
    const [row] = newRows(parsePasteText('relever un défi'));
    expect(row.expressionFr).toBe('relever un défi');
    expect(row.meaningKo).toBe('');
    expect(row.status).toBe('new');
  });
});

describe('parsePasteText - title lines become tags', () => {
  it('a heading line tags the rows below it until the next heading', () => {
    const text = `# penser à / penser de
Je pense à lui. — 나는 그를 생각해.
## autre groupe
Je pense à toi. — 나는 너를 생각해.`;
    const rows = newRows(parsePasteText(text));
    expect(rows).toHaveLength(2);
    expect(rows[0].tags).toEqual(['penser à / penser de']);
    expect(rows[1].tags).toEqual(['autre groupe']);
  });

  it('a bold-wrapped line is also treated as a title', () => {
    const text = `**오늘 배운 표현**
Je pense à lui. — 나는 그를 생각해.`;
    const rows = newRows(parsePasteText(text));
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toEqual(['오늘 배운 표현']);
  });
});

describe('parsePasteText - Korean-only or uninterpretable lines need review', () => {
  it('flags a pure-Korean sentence as needs_review', () => {
    const result = parsePasteText('오늘 배운 표현이 정말 많다.');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe('needs_review');
    expect(result.rows[0].originalLine).toBe('오늘 배운 표현이 정말 많다.');
    expect(result.needsReviewCount).toBe(1);
  });
});

describe('parsePasteText - ignores ChatGPT preamble/closing remarks', () => {
  it('still extracts the real rows correctly when wrapped in explanatory text', () => {
    const text = `다음은 오늘 배운 표현을 정리한 것입니다.

${USER_EXAMPLE}

도움이 되었으면 좋겠어요!`;
    const rows = newRows(parsePasteText(text));
    expect(rows).toHaveLength(3);
    expect(rows[0].expressionFr).toBe('Je pense à lui.');
    expect(rows[2].expressionFr).toBe("Pense à l'appeler.");
  });
});

describe('parsePasteText - trailing markdown line-break backslash', () => {
  it('strips a trailing backslash with no separator', () => {
    const [row] = newRows(parsePasteText('Il me semble que cette solution est plus simple.\\'));
    expect(row.expressionFr).toBe('Il me semble que cette solution est plus simple.');
  });

  it('strips a trailing backslash after a split', () => {
    const [row] = newRows(parsePasteText("J'ai beau étudier, je fais encore des erreurs. — 아무리 공부해도 여전히 실수를 해. \\"));
    expect(row.expressionFr).toBe("J'ai beau étudier, je fais encore des erreurs.");
    expect(row.meaningKo).toBe('아무리 공부해도 여전히 실수를 해.');
  });

  it('does not touch real hyphens/apostrophes while stripping the backslash', () => {
    const [row] = newRows(parsePasteText("Peut-être qu'il viendra. — 아마 그가 올 거야.\\"));
    expect(row.expressionFr).toBe("Peut-être qu'il viendra.");
  });
});

describe('parsePasteText - blank lines are ignored', () => {
  it('skips blank lines without producing rows or errors', () => {
    const result = parsePasteText('confier — 맡기다\n\n\nse confier — 속마음을 털어놓다\n');
    expect(newRows(result)).toHaveLength(2);
  });
});

describe('markPasteDuplicates', () => {
  it('marks a row as duplicate when it matches an existing expression', () => {
    const existing: ExistingExpressionLookup[] = [
      { id: 'existing-1', expression_fr: 'confier', meaning_ko: '맡기다' },
    ];
    const [row] = newRows(parsePasteText('confier — 맡기다'));
    const [marked] = markPasteDuplicates([row], existing);
    expect(marked.status).toBe('duplicate');
    expect(marked.existingExpressionId).toBe('existing-1');
  });

  it('accent differences are NOT duplicates', () => {
    const existing: ExistingExpressionLookup[] = [{ id: 'existing-1', expression_fr: 'ou', meaning_ko: '또는' }];
    const [row] = newRows(parsePasteText('où — 어디'));
    const [marked] = markPasteDuplicates([row], existing);
    expect(marked.status).toBe('new');
  });

  it('curly vs straight apostrophe ARE duplicates', () => {
    const existing: ExistingExpressionLookup[] = [
      { id: 'existing-1', expression_fr: "aujourd’hui", meaning_ko: '오늘' },
    ];
    const [row] = newRows(parsePasteText("aujourd'hui — 오늘"));
    const [marked] = markPasteDuplicates([row], existing);
    expect(marked.status).toBe('duplicate');
  });

  it('pasting the exact same text twice produces zero new duplicates on the second pass', () => {
    const firstPass = newRows(parsePasteText(USER_EXAMPLE));
    const existingFromFirstPass: ExistingExpressionLookup[] = firstPass.map((row, i) => ({
      id: `saved-${i}`,
      expression_fr: row.expressionFr,
      meaning_ko: row.meaningKo,
    }));

    const secondPass = newRows(parsePasteText(USER_EXAMPLE));
    const marked = markPasteDuplicates(secondPass, existingFromFirstPass);
    expect(marked.every((row) => row.status === 'duplicate')).toBe(true);
  });

  it('duplicates within the same batch are caught (not just against the DB)', () => {
    const text = 'confier — 맡기다\nconfier — 맡기다';
    const rows = newRows(parsePasteText(text));
    const marked = markPasteDuplicates(rows, []);
    expect(marked[0].status).toBe('new');
    expect(marked[1].status).toBe('duplicate');
  });
});
