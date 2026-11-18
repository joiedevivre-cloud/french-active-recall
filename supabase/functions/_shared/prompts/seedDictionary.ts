// seed_dictionary ("사전 쓰임 추가 (AI)"): surveys a lemma's grammatical
// constructions from general knowledge (no sentence input), then a STRONGER
// model checks every usage AND looks for important constructions that were
// missed, before anything is shown or saved.
//
// Goal (learner's own words): not "make N usages", but "do not miss an
// important construction, and do not duplicate what is already there".
// In French the preposition / complement often changes the meaning
// (penser à / penser de / penser que / penser + inf.), so usages are split by
// CONSTRUCTION, never by Korean translation.
//
// No fixed limit on usages: frequent constructions are tier 'core'
// (preselected), the rest tier 'extra' ("추가 쓰임", shown, unticked).
// SEED_MAX_CANDIDATES is only a safety cap; anything cut by it is listed with
// its reason.
//
// Flow (analyze-lemma, action 'seed_dictionary'):
//   mode 'preview': generate (cheap model) -> verify + find missing (strong
//                   model) -> prepareSeedSenses (code rules) -> returned, NOT saved
//   mode 'apply'  : the senses the learner ticked are re-checked by
//                   prepareSeedSenses (code rules only, no AI) and saved
//
// Pure (no Deno APIs) -- tested from src/features/vocabulary/seedDictionary.test.ts.
import { calqueReason, canonicalizePattern } from '../patternNotation.ts';
import { patternKey } from '../lemmaMatching.ts';

/** safety cap on candidates per run -- not a learning limit */
export const SEED_MAX_CANDIDATES = 10;
export const SEED_MAX_EXAMPLES = 3;

export interface SeedExample {
  fr: string;
  ko: string;
}

export type SeedTier = 'core' | 'extra';

export interface SeedSense {
  label: string;
  meaning_ko: string;
  pattern: string;
  tier: SeedTier;
  required_complement: 'nom' | 'pronom' | 'infinitif' | 'clause' | 'independent';
  mood_requirement: 'indicatif' | 'subjonctif' | 'conditionnel' | 'none';
  /** e.g. "부정문·의문문에서는 접속법(subjonctif)이 올 수 있어요." -- "" if nothing to add */
  mood_note_ko: string;
  /** how this construction differs from the lemma's other constructions (1 sentence) */
  contrast_ko: string;
  grammar_explanation_ko: string;
  common_mistakes_ko: string[];
  examples: SeedExample[];
}

const NOTATION_RULES = `Pattern notation (mandatory): standard dictionary notation --
qqn = a person, qqch = a thing, qqn/qqch = either, inf. = an infinitive, proposition = a clause.
Examples: "confier qqch à qqn", "se confier à qqn", "se mettre à + inf.", "tenir à qqn/qqch", "sembler que + proposition".
Never write "nom (사람)", "groupe nominal (personne)" or similar.`;

const USAGE_FIELDS = `Each usage:
- label: short Korean label.
- meaning_ko: short Korean meaning.
- pattern: the construction, in the notation above.
- tier: "core" = frequent in everyday French and needed at A2~B2; "extra" = real and useful but less frequent.
- required_complement: "nom" | "pronom" | "infinitif" | "clause" | "independent".
- mood_requirement: mood of the clause ("indicatif" | "subjonctif" | "conditionnel"), "none" if there is no clause.
- mood_note_ko: one Korean sentence when the mood changes in some contexts (e.g. a "que" clause in the indicative that takes the subjonctif in negative or interrogative sentences), else "".
- contrast_ko: one Korean sentence on how this construction differs in meaning from the lemma's other constructions (e.g. "Que penses-tu de ce film ?" = 평가·의견 vs "Tu penses à ce film ?" = 떠올림), else "".
- grammar_explanation_ko: 1-2 Korean sentences, naming the construction with French grammar terms (préposition, complément d'objet direct/indirect, infinitif, proposition subordonnée complétive, indicatif, subjonctif).
- common_mistakes_ko: 0-2 genuinely common mistakes Korean learners make with THIS usage; [] if none -- never invent one.
- examples: 1-${SEED_MAX_EXAMPLES} natural French sentences (generic, no real person's facts) with an exact Korean translation.`;

export const SEED_GENERATE_SYSTEM_PROMPT = `You are a French lexicographer building a personal vocabulary entry for a Korean-speaking learner (A2~B2, Montreal). Given ONE French lemma (dictionary form), survey ALL of its main grammatical constructions and list them, most frequent first.

A usage = one distinct CONSTRUCTION. Rules:
1. Survey first: transitive / intransitive, every preposition the verb takes (à, de, en, pour, sur...), + inf., que + proposition, pronominal form. When the preposition or complement changes the meaning, it is a SEPARATE usage -- but only when meaning and use really differ. Illustration with "tenir" (another verb, for the method only): tenir qqch (잡다), tenir à qqn/qqch (아끼다), tenir à + inf. (꼭 ~하고 싶다), tenir de qqn (닮다), se tenir (자세를 유지하다).
2. Never list the same construction twice. A variation inside the same construction (e.g. "confier un secret à qqn" is "confier qqch à qqn" with qqch = un secret) is NOT a new usage -- make it an extra example and widen the Korean label if needed ("맡기다 / (비밀을) 털어놓다").
3. Only constructions native speakers really use. Never translate an English construction word for word ("entrust A with B" -> "confier qqn avec qqch" is NOT French). If unsure, leave it out.
4. Do not split by Korean translation: one construction with several Korean equivalents is ONE usage.
5. At most ${SEED_MAX_CANDIDATES} usages; use "core" / "extra" instead of dropping important ones.

${NOTATION_RULES}

${USAGE_FIELDS}

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
    tier: { type: 'string', enum: ['core', 'extra'] },
    required_complement: { type: 'string', enum: ['nom', 'pronom', 'infinitif', 'clause', 'independent'] },
    mood_requirement: { type: 'string', enum: ['indicatif', 'subjonctif', 'conditionnel', 'none'] },
    mood_note_ko: { type: 'string' },
    contrast_ko: { type: 'string' },
    grammar_explanation_ko: { type: 'string' },
    common_mistakes_ko: { type: 'array', items: { type: 'string' } },
    examples: { type: 'array', items: EXAMPLE_SCHEMA },
  },
  required: [
    'label', 'meaning_ko', 'pattern', 'tier', 'required_complement', 'mood_requirement', 'mood_note_ko', 'contrast_ko',
    'grammar_explanation_ko', 'common_mistakes_ko', 'examples',
  ],
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
  tier: SeedTier;
  examples: SeedExample[];
  reason_ko: string;
}

export const SEED_VERIFY_SYSTEM_PROMPT = `You are a strict native-speaker French lexicographer reviewing a vocabulary entry that a smaller model generated for a Korean-speaking learner. Learners will practise these usages repeatedly, so a wrong usage is harmful, and a MISSING important construction is also a failure.

Task 1 -- for EACH usage (by index):
- "drop": not used in real French (e.g. a word-for-word English calque such as "confier qqn avec qqch"), extremely rare, or the same construction as an earlier usage (say which in reason_ko).
- "fix": real construction but something is wrong -- pattern notation, Korean label/meaning, tier, an unnatural or ungrammatical example, or a Korean translation that does not match the French exactly (e.g. "ma voiture" translated as "그의 차"). Return corrected values.
- "keep": everything is correct (repeat the input values).
Check every example word by word: grammar, agreement (including past-participle agreement), prepositions, and that it really uses THIS construction. Remove examples you cannot fix.

Task 2 -- "missing": list the important constructions of this lemma that the entry does not cover, especially ones where a different preposition / complement changes the meaning (à vs de vs que vs + inf.). Same construction as an existing usage is NOT missing. Return [] if nothing important is missing. Same fields as a usage.

${NOTATION_RULES}

${USAGE_FIELDS}

reason_ko: one short Korean sentence (empty for "keep").`;

export function buildSeedVerifyUserPrompt(lemma: string, senses: SeedSense[]): string {
  return JSON.stringify({
    lemma,
    usages: senses.map((s, index) => ({ index, label: s.label, meaning_ko: s.meaning_ko, pattern: s.pattern, tier: s.tier, examples: s.examples })),
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
          tier: { type: 'string', enum: ['core', 'extra'] },
          examples: { type: 'array', items: EXAMPLE_SCHEMA },
          reason_ko: { type: 'string' },
        },
        required: ['index', 'verdict', 'label', 'meaning_ko', 'pattern', 'tier', 'examples', 'reason_ko'],
        additionalProperties: false,
      },
    },
    missing: { type: 'array', items: SENSE_SCHEMA },
  },
  required: ['verdicts', 'missing'],
  additionalProperties: false,
};

// --- French grammar terms per usage (code, deterministic) --------------------

const PREPOSITIONS = ['à', 'de', 'en', 'pour', 'sur', 'avec', 'par', 'dans', 'chez', 'contre', 'entre', 'vers', 'sans', 'sous'];
const MOOD_FR: Record<string, string> = { indicatif: 'indicatif', subjonctif: 'subjonctif', conditionnel: 'conditionnel' };

/**
 * Grammar labels shown on each usage card, derived from the canonical
 * pattern (not from AI text, so they are always consistent):
 * "penser de qqch" -> ["préposition de"], "penser que + proposition" (indicatif)
 * -> ["proposition subordonnée complétive", "indicatif"].
 */
export function grammarTermsFor(canonicalPattern: string, mood: SeedSense['mood_requirement'] | null | undefined): string[] {
  const tokens = canonicalPattern.toLowerCase().split(' ').filter((t) => t && t !== '+');
  const terms: string[] = [];
  if (tokens[0] === 'se' || tokens[0] === "s'" || tokens[0]?.startsWith("s'")) terms.push('verbe pronominal');
  const verbIdx = tokens[0] === 'se' ? 1 : 0;
  const afterVerb = tokens[verbIdx + 1];
  if (afterVerb === 'qqch' || afterVerb === 'qqn' || afterVerb === 'qqn/qqch') terms.push("complément d'objet direct");
  tokens.forEach((t, i) => {
    if (i <= verbIdx) return;
    const prep = PREPOSITIONS.find((p) => t === p);
    if (prep) {
      const next = tokens[i + 1];
      terms.push(`préposition ${prep}`);
      if (prep === 'à' && (next === 'qqn' || next === 'qqn/qqch')) terms.push("complément d'objet indirect");
    }
  });
  if (tokens.includes('inf.')) terms.push('infinitif');
  if (tokens.includes('proposition')) terms.push(tokens.includes('que') ? 'proposition subordonnée complétive' : 'proposition subordonnée');
  if (mood && MOOD_FR[mood] && tokens.includes('proposition')) terms.push(MOOD_FR[mood]);
  return [...new Set(terms)];
}

// --- code rules (run on preview AND again on apply) ---------------------------

export interface PreparedSense extends SeedSense {
  /** existing usage with the same construction -> examples are added there instead of a new usage */
  mergeTargetId: string | null;
  mergeTargetLabel: string | null;
  /** 'fix' = the self-check corrected something; 'added' = the self-check found it missing */
  checked: 'keep' | 'fix' | 'added' | 'unchecked';
  note_ko: string;
  /**
   * No exact match, but an existing usage differs only by qqn <-> qqch
   * (new "penser à qqch" vs existing "penser à qqn"). The learner decides:
   * add as examples there (default), or keep it as a new usage.
   */
  similarTargetId: string | null;
  similarTargetLabel: string | null;
  similarTargetPattern: string | null;
  grammar_terms: string[];
}

export interface RejectedSense {
  label: string;
  pattern: string;
  reason_ko: string;
}

/** Looser key: qqn and qqch treated as the same slot. Only used to SUGGEST a merge, never to merge automatically. */
export function looseKey(pattern: string): string {
  // patternKey output only has [a-z0-9+ ], so "qqn/qqch" is already "qqn qqch" here
  const tokens = patternKey(pattern).split(' ').map((t) => (t === 'qqn' || t === 'qqch' ? 'qqx' : t));
  return tokens.filter((t, i) => !(t === 'qqx' && tokens[i - 1] === 'qqx')).join(' ');
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
    tier: r.tier === 'extra' ? 'extra' : 'core',
    required_complement: COMPLEMENTS.includes(r.required_complement as never) ? (r.required_complement as SeedSense['required_complement']) : 'nom',
    mood_requirement: MOODS.includes(r.mood_requirement as never) ? (r.mood_requirement as SeedSense['mood_requirement']) : 'none',
    mood_note_ko: str(r.mood_note_ko, 300),
    contrast_ko: str(r.contrast_ko, 300),
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
 *  - qqn/qqch-only difference from an existing usage -> suggested merge (learner decides)
 *  - no example left -> rejected (a usage must be practisable)
 *  - core first, then extra; SEED_MAX_CANDIDATES safety cap (cut ones listed)
 * `missingFromIndex`: senses at or after this index were added by the self-check.
 */
export function prepareSeedSenses(
  senses: SeedSense[],
  verdicts: SeedVerdict[] | null,
  existingUsages: { id: string; label: string; pattern: string | null }[],
  options: { missingFromIndex?: number; chosenMerges?: (string | null)[] } = {}
): { accepted: PreparedSense[]; rejected: RejectedSense[] } {
  const missingFrom = options.missingFromIndex ?? Number.POSITIVE_INFINITY;
  const chosenMerges = options.chosenMerges ?? [];
  const accepted: PreparedSense[] = [];
  const rejected: RejectedSense[] = [];
  const existingByKey = new Map<string, { id: string; label: string }>();
  for (const u of existingUsages) if (u.pattern) existingByKey.set(patternKey(u.pattern), { id: u.id, label: u.label });
  const similarExisting = (pattern: string) => existingUsages.find((u) => u.pattern && looseKey(u.pattern) === looseKey(pattern)) ?? null;

  senses.forEach((original, index) => {
    let sense: SeedSense = original;
    let checked: PreparedSense['checked'] = 'unchecked';
    let note = '';
    if (verdicts && index >= missingFrom) {
      checked = 'added';
      note = '검증 단계에서 빠진 구조로 추가됐어요.';
    } else if (verdicts) {
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
        sense = {
          ...original,
          label: v.label || original.label,
          meaning_ko: v.meaning_ko || original.meaning_ko,
          pattern: v.pattern || original.pattern,
          tier: v.tier === 'extra' ? 'extra' : 'core',
          examples: cleanExamples(v.examples),
        };
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
    let target = existingByKey.get(key) ?? null;
    const similar = target ? null : similarExisting(pattern);
    if (!target && similar && chosenMerges[index] === similar.id) target = { id: similar.id, label: similar.label };
    accepted.push({
      ...sense,
      pattern,
      examples: examples.slice(0, SEED_MAX_EXAMPLES),
      mergeTargetId: target?.id ?? null,
      mergeTargetLabel: target?.label ?? null,
      checked,
      note_ko: note,
      similarTargetId: target ? null : similar?.id ?? null,
      similarTargetLabel: target ? null : similar?.label ?? null,
      similarTargetPattern: target ? null : similar?.pattern ?? null,
      grammar_terms: grammarTermsFor(pattern, sense.mood_requirement),
    });
  });

  // core first (stable within a tier), then the safety cap
  const ordered = [...accepted.filter((a) => a.tier === 'core'), ...accepted.filter((a) => a.tier === 'extra')];
  for (const cut of ordered.slice(SEED_MAX_CANDIDATES)) {
    rejected.push({ label: cut.label, pattern: cut.pattern, reason_ko: `한 번에 최대 ${SEED_MAX_CANDIDATES}개까지만 보여 줘요. 다시 실행하면 나머지를 볼 수 있어요.` });
  }
  return { accepted: ordered.slice(0, SEED_MAX_CANDIDATES), rejected };
}

/** Examples merged into an existing usage: existing first, new ones appended, no duplicates. */
export function mergeExamples(existing: unknown, added: SeedExample[]): SeedExample[] {
  return cleanExamples([...(Array.isArray(existing) ? existing : []), ...added]);
}
