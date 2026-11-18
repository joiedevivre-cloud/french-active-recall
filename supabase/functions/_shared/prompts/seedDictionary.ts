// seed_dictionary ("사전 쓰임 추가 (AI)"): generates a lemma's main
// dictionary usages from general knowledge (no sentence input), then a
// STRONGER model checks every usage before anything is shown or saved.
//
// Why two steps: gpt-4o-mini produced "confier qqn avec qqch" (an English
// calque of "entrust A with B") and a duplicate of an existing usage. Usages
// become writing-practice prompts later, so a wrong usage would be
// practised over and over -- it must be blocked here.
//
// Flow (analyze-lemma, action 'seed_dictionary'):
//   mode 'preview': generate (cheap model) -> verify (strong model) ->
//                   prepareSeedSenses (code rules) -> returned, NOT saved
//   mode 'apply'  : the user-selected senses from the preview are re-checked
//                   by prepareSeedSenses (code rules only, no AI) and saved
//
// Pure (no Deno APIs) -- tested from src/features/vocabulary/seedDictionary.test.ts.
import { calqueReason, canonicalizePattern } from '../patternNotation.ts';
import { patternKey } from '../lemmaMatching.ts';

export const SEED_MAX_SENSES = 4;
export const SEED_MAX_EXAMPLES = 3;

export interface SeedExample {
  fr: string;
  ko: string;
}

export interface SeedSense {
  label: string;
  meaning_ko: string;
  pattern: string;
  required_complement: 'nom' | 'pronom' | 'infinitif' | 'clause' | 'independent';
  mood_requirement: 'indicatif' | 'subjonctif' | 'conditionnel' | 'none';
  grammar_explanation_ko: string;
  common_mistakes_ko: string[];
  examples: SeedExample[];
}

const NOTATION_RULES = `Pattern notation (mandatory): write the construction in standard dictionary notation --
qqn = a person, qqch = a thing, inf. = an infinitive, proposition = a clause.
Examples: "confier qqch à qqn", "se confier à qqn", "se mettre à + inf.", "penser à qqn", "sembler que + proposition".
Never write "nom (사람)", "groupe nominal (personne)" or similar -- only qqn / qqch / inf. / proposition.`;

export const SEED_GENERATE_SYSTEM_PROMPT = `You are a French dictionary/teacher assistant building a personal vocabulary entry for a Korean-speaking learner (A2~B2, Montreal). Given ONE French lemma (dictionary form), list its main usages, ordered by how frequent they are in real everyday French (most frequent first).

A usage = one distinct CONSTRUCTION (pattern). Rules:
1. At most ${SEED_MAX_SENSES} usages.
2. Never list two usages with the same construction. A variation inside the same construction (e.g. "confier un secret à qqn" is just "confier qqch à qqn" with qqch = un secret) is NOT a new usage -- put it as an extra example of that usage, and widen the Korean label if needed (e.g. "맡기다 / (비밀을) 털어놓다").
3. Only constructions that native speakers really use. Never translate an English construction word for word (e.g. "entrust A with B" -> "confier qqn avec qqch" is NOT French). If unsure, leave the usage out.
4. The pronominal form is a separate usage only when its construction differs (e.g. "se confier à qqn" has no direct object, unlike "confier qqch à qqn").

${NOTATION_RULES}

Each usage:
- label: short Korean label.
- meaning_ko: short Korean meaning.
- pattern: the construction, in the notation above.
- required_complement: "nom" | "pronom" | "infinitif" | "clause" | "independent".
- mood_requirement: "indicatif" | "subjonctif" | "conditionnel" | "none" (only meaningful for "clause").
- grammar_explanation_ko: 1-2 Korean sentences.
- common_mistakes_ko: 0-2 genuinely common mistakes Korean learners make with THIS usage; [] if none stand out -- never invent one.
- examples: 1-${SEED_MAX_EXAMPLES} natural French sentences (generic, no real person's facts) with an exact Korean translation. Include the variations from rule 2 here.

Never produce Korean phonetic transliteration.`;

export function buildSeedGenerateUserPrompt(lemma: string): string {
  return JSON.stringify({ lemma });
}

const EXAMPLE_SCHEMA = {
  type: 'object',
  properties: { fr: { type: 'string' }, ko: { type: 'string' } },
  required: ['fr', 'ko'],
  additionalProperties: false,
};

const SENSE_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    meaning_ko: { type: 'string' },
    pattern: { type: 'string' },
    required_complement: { type: 'string', enum: ['nom', 'pronom', 'infinitif', 'clause', 'independent'] },
    mood_requirement: { type: 'string', enum: ['indicatif', 'subjonctif', 'conditionnel', 'none'] },
    grammar_explanation_ko: { type: 'string' },
    common_mistakes_ko: { type: 'array', items: { type: 'string' } },
    examples: { type: 'array', items: EXAMPLE_SCHEMA },
  },
  required: ['label', 'meaning_ko', 'pattern', 'required_complement', 'mood_requirement', 'grammar_explanation_ko', 'common_mistakes_ko', 'examples'],
  additionalProperties: false,
};

export const SEED_GENERATE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { senses: { type: 'array', items: SENSE_SCHEMA } },
  required: ['senses'],
  additionalProperties: false,
};

// --- self-check (strong model) ----------------------------------------------

export interface SeedVerdict {
  index: number;
  verdict: 'keep' | 'fix' | 'drop';
  /** corrected values (for 'keep' they repeat the input) */
  label: string;
  meaning_ko: string;
  pattern: string;
  examples: SeedExample[];
  reason_ko: string;
}

export const SEED_VERIFY_SYSTEM_PROMPT = `You are a strict native-speaker French lexicographer reviewing dictionary usages that a smaller model generated for a Korean-speaking learner. Learners will practise these usages repeatedly, so a wrong one is harmful: when in doubt, drop it.

For EACH usage (by index) decide:
- "drop": the construction is not used in real French (e.g. a word-for-word English calque such as "confier qqn avec qqch"), or the usage is extremely rare, or it is the same construction as an earlier usage in the list (say which one in reason_ko).
- "fix": the construction is real but something is wrong -- the pattern notation, the Korean label/meaning, an example sentence that is unnatural or ungrammatical, or a Korean translation that does not match the French exactly (e.g. "ma voiture" translated as "그의 차"). Return the corrected values.
- "keep": everything is correct.

Check every example sentence word by word: grammar, agreement (including past-participle agreement), prepositions, and that it actually uses THIS usage's construction. Remove examples you cannot fix.

${NOTATION_RULES}

Return one verdict per input usage, same order. For "keep" repeat the input values. reason_ko: one short Korean sentence (empty for "keep").`;

export function buildSeedVerifyUserPrompt(lemma: string, senses: SeedSense[]): string {
  return JSON.stringify({
    lemma,
    usages: senses.map((s, index) => ({ index, label: s.label, meaning_ko: s.meaning_ko, pattern: s.pattern, examples: s.examples })),
  });
}

export const SEED_VERIFY_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['keep', 'fix', 'drop'] },
          label: { type: 'string' },
          meaning_ko: { type: 'string' },
          pattern: { type: 'string' },
          examples: { type: 'array', items: EXAMPLE_SCHEMA },
          reason_ko: { type: 'string' },
        },
        required: ['index', 'verdict', 'label', 'meaning_ko', 'pattern', 'examples', 'reason_ko'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

// --- code rules (run on preview AND again on apply) ---------------------------

export interface PreparedSense extends SeedSense {
  /** existing usage of this lemma with the same construction -> examples are added there instead of a new usage */
  mergeTargetId: string | null;
  mergeTargetLabel: string | null;
  /** 'fix' when the self-check corrected something */
  checked: 'keep' | 'fix' | 'unchecked';
  note_ko: string;
}

export interface RejectedSense {
  label: string;
  pattern: string;
  reason_ko: string;
}

function cleanExamples(examples: unknown): SeedExample[] {
  if (!Array.isArray(examples)) return [];
  const seen = new Set<string>();
  const out: SeedExample[] = [];
  for (const e of examples) {
    const fr = typeof e?.fr === 'string' ? e.fr.trim().slice(0, 300) : '';
    const ko = typeof e?.ko === 'string' ? e.ko.trim().slice(0, 300) : '';
    if (!fr || seen.has(fr)) continue;
    seen.add(fr);
    out.push({ fr, ko });
  }
  return out;
}

const COMPLEMENTS = ['nom', 'pronom', 'infinitif', 'clause', 'independent'] as const;
const MOODS = ['indicatif', 'subjonctif', 'conditionnel', 'none'] as const;

/** Coerces untrusted input (AI output or the client's apply body) into a SeedSense, or null. */
export function sanitizeSense(raw: unknown): SeedSense | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const label = str(r.label, 80);
  const pattern = str(r.pattern, 160);
  if (!label || !pattern) return null;
  return {
    label,
    meaning_ko: str(r.meaning_ko, 200),
    pattern,
    required_complement: COMPLEMENTS.includes(r.required_complement as never) ? (r.required_complement as SeedSense['required_complement']) : 'nom',
    mood_requirement: MOODS.includes(r.mood_requirement as never) ? (r.mood_requirement as SeedSense['mood_requirement']) : 'none',
    grammar_explanation_ko: str(r.grammar_explanation_ko, 600),
    common_mistakes_ko: Array.isArray(r.common_mistakes_ko) ? r.common_mistakes_ko.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 2) : [],
    examples: cleanExamples(r.examples),
  };
}

/**
 * Applies the self-check verdicts (when given) and the code rules:
 *  - pattern stored in standard notation (canonicalizePattern)
 *  - English-calque guard (calqueReason) -- independent of the AI check
 *  - same construction twice in the list -> merged (examples combined)
 *  - same construction as an existing usage -> examples go to that usage
 *  - no example left -> rejected (a usage must be practisable)
 *  - at most SEED_MAX_SENSES, in the given (frequency) order
 */
export function prepareSeedSenses(
  senses: SeedSense[],
  verdicts: SeedVerdict[] | null,
  existingUsages: { id: string; label: string; pattern: string | null }[]
): { accepted: PreparedSense[]; rejected: RejectedSense[] } {
  const accepted: PreparedSense[] = [];
  const rejected: RejectedSense[] = [];
  const existingByKey = new Map<string, { id: string; label: string }>();
  for (const u of existingUsages) if (u.pattern) existingByKey.set(patternKey(u.pattern), { id: u.id, label: u.label });

  senses.forEach((original, index) => {
    let sense: SeedSense = original;
    let checked: PreparedSense['checked'] = 'unchecked';
    let note = '';
    if (verdicts) {
      const v = verdicts.find((x) => x.index === index);
      if (!v) {
        rejected.push({ label: original.label, pattern: original.pattern, reason_ko: '검증 결과가 없어 제외했어요.' });
        return;
      }
      if (v.verdict === 'drop') {
        rejected.push({ label: original.label, pattern: original.pattern, reason_ko: v.reason_ko || '검증에서 제외됐어요.' });
        return;
      }
      if (v.verdict === 'fix') {
        sense = { ...original, label: v.label || original.label, meaning_ko: v.meaning_ko || original.meaning_ko, pattern: v.pattern || original.pattern, examples: cleanExamples(v.examples) };
        checked = 'fix';
        note = v.reason_ko;
      } else {
        checked = 'keep';
      }
    }

    const pattern = canonicalizePattern(sense.pattern);
    const calque = calqueReason(pattern);
    if (calque) {
      rejected.push({ label: sense.label, pattern, reason_ko: calque });
      return;
    }
    const examples = cleanExamples(sense.examples);
    const key = patternKey(pattern);

    const dup = accepted.find((a) => patternKey(a.pattern) === key);
    if (dup) {
      dup.examples = cleanExamples([...dup.examples, ...examples]).slice(0, SEED_MAX_EXAMPLES);
      rejected.push({ label: sense.label, pattern, reason_ko: `"${dup.label}"와 같은 구문이라 그 예문으로 합쳤어요.` });
      return;
    }
    if (examples.length === 0) {
      rejected.push({ label: sense.label, pattern, reason_ko: '쓸 수 있는 예문이 없어 제외했어요.' });
      return;
    }
    if (accepted.length >= SEED_MAX_SENSES) {
      rejected.push({ label: sense.label, pattern, reason_ko: `쓰임은 최대 ${SEED_MAX_SENSES}개까지만 추가해요.` });
      return;
    }
    const target = existingByKey.get(key) ?? null;
    accepted.push({
      ...sense,
      pattern,
      examples: examples.slice(0, SEED_MAX_EXAMPLES),
      mergeTargetId: target?.id ?? null,
      mergeTargetLabel: target?.label ?? null,
      checked,
      note_ko: note,
    });
  });

  return { accepted, rejected };
}

/** Examples merged into an existing usage: existing first, new ones appended, no duplicates. */
export function mergeExamples(existing: unknown, added: SeedExample[]): SeedExample[] {
  return cleanExamples([...(Array.isArray(existing) ? existing : []), ...added]);
}
