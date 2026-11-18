// Shared prompts for the analyze-lemma Edge Function AND
// scripts/backfill-analysis.ts (service-role backfill) -- both must send
// the exact same prompt/schema, so this lives in one place neither imports
// is allowed to diverge it. Bump PROMPT_VERSION whenever a prompt/schema
// changes; expression_analysis.prompt_version records which version
// produced a given row.
//
// v2: removed Korean phonetic transliteration everywhere (never asked
// for, not useful for learning real French pronunciation) in favor of
// real IPA; added a strict pattern-based usage-matching requirement
// (classify) and a separate dictionary-seeding task (seed_dictionary).
export const PROMPT_VERSION = 'analyze-v2';

const KNOWN_METTRE_FAMILY_PATTERNS = [
  'se mettre à + infinitif', 'mettre à jour', 'mettre en place',
  'mettre du temps à + infinitif', 'mettre en marche', 'mettre de côté', 'mettre en pratique',
].join(', ');

export const ANALYZE_SYSTEM_PROMPT = `You are a French teacher helping a Korean-speaking learner (studying in Montreal, A2~B2 level) build a personal "lemma dictionary" from sentences they encountered.

Given ONE French sentence/expression and the user's EXISTING lemmas+usages for its key word (if any), identify:

1. lemma: the dictionary/infinitive form of the single most important word in the sentence (usually the main verb, e.g. "mettre" for "Il a mis la table", or a key noun/expression if there's no notable verb).
2. part_of_speech: e.g. "verbe", "nom", "expression".
3. pronunciation_ipa: real IPA for the lemma's dictionary form, e.g. "/mɛtʀ/". Never produce a Korean phonetic transliteration anywhere in this response -- IPA only.
4. grammar_notes: {conjugation_present: a few key present-tense forms as one short string, past_participle, auxiliary ("avoir"/"être"/null if not a verb), common_mistakes: 0-3 short Korean strings -- ONLY mistakes that are actually grammatically sensible for this word's real part_of_speech (e.g. NEVER mention gender agreement for a verb, NEVER invent a "confused with X" claim that isn't a real, common confusion). Return an empty array rather than inventing something that doesn't make sense.}.
5. usage: which DISTINCT grammatical construction/sense this specific sentence demonstrates. Recognize multi-word idiomatic/semi-auxiliary patterns even when conjugated, reflexive-pronoun-varied, or split by an inserted object (e.g. "se mettre à" realized as "je me suis mise à chercher"). Known patterns for words like "mettre" (not exhaustive -- recognize others the same way): ${KNOWN_METTRE_FAMILY_PATTERNS}. If the EXISTING usages list already contains one whose "pattern" field is THE SAME construction (not just the same lemma, not just a similar meaning), SET existing_usage_id to its id and reuse its exact label/meaning_ko/pattern. Only invent a new usage (existing_usage_id: null) when no existing pattern is genuinely the same construction -- do NOT attach a sentence to an existing usage just because it shares the lemma or has a loosely similar meaning; a wrong attachment is worse than creating a new usage.
   - label: short Korean label for this usage (e.g. "옷을 입다").
   - meaning_ko: short Korean meaning.
   - pattern: the exact syntactic construction, written with correct French grammar terms, e.g. "mettre + groupe nominal (vêtement)" or "se mettre à + infinitif". This is the field used to decide whether an existing usage really matches -- be precise and consistent.
6. sentence_pronunciation: {pronunciation_ipa: real IPA for THIS WHOLE SENTENCE (not just the lemma), pronunciation_note: 0-1 short Korean note about a genuine phonetic phenomenon in this sentence (liaison, enchaînement, voyelle nasale, élision) -- name the phenomenon with its French term and explain briefly in Korean, or "" if nothing notable. Never produce a Korean transliteration here either.}.
7. grammar_points: 1 to 3 objects {form, meaning, example} -- the actual grammar point(s) in THIS sentence (tense/mood/agreement/preposition choice), anchored to this sentence, not a generic definition. example is a different French sentence using the same point.
8. level: your best CEFR estimate for this sentence, one of A1/A2/B1/B2.

Never invent facts about the sentence that aren't there. Return existing_usage_id as null if there is no existing-usages list or none genuinely matches the same construction.`;

export interface ExistingUsageContext {
  id: string;
  label: string;
  meaning_ko: string | null;
  pattern: string | null;
}

export interface ExistingLemmaContext {
  id: string;
  lemma: string;
  part_of_speech: string | null;
  usages: ExistingUsageContext[];
}

export function buildUserPrompt(sentence: string, existingLemmas: ExistingLemmaContext[]): string {
  return JSON.stringify({ sentence, existing_lemmas_for_reference: existingLemmas });
}

export const ANALYZE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    lemma: { type: 'string' },
    part_of_speech: { type: 'string' },
    pronunciation_ipa: { type: 'string' },
    grammar_notes: {
      type: 'object',
      properties: {
        conjugation_present: { type: 'string' },
        past_participle: { type: 'string' },
        auxiliary: { type: ['string', 'null'] },
        common_mistakes: { type: 'array', items: { type: 'string' } },
      },
      required: ['conjugation_present', 'past_participle', 'auxiliary', 'common_mistakes'],
      additionalProperties: false,
    },
    usage: {
      type: 'object',
      properties: {
        existing_usage_id: { type: ['string', 'null'] },
        label: { type: 'string' },
        meaning_ko: { type: 'string' },
        pattern: { type: 'string' },
      },
      required: ['existing_usage_id', 'label', 'meaning_ko', 'pattern'],
      additionalProperties: false,
    },
    sentence_pronunciation: {
      type: 'object',
      properties: {
        pronunciation_ipa: { type: 'string' },
        pronunciation_note: { type: 'string' },
      },
      required: ['pronunciation_ipa', 'pronunciation_note'],
      additionalProperties: false,
    },
    grammar_points: {
      type: 'array',
      items: {
        type: 'object',
        properties: { form: { type: 'string' }, meaning: { type: 'string' }, example: { type: 'string' } },
        required: ['form', 'meaning', 'example'],
        additionalProperties: false,
      },
    },
    level: { type: 'string', enum: ['A1', 'A2', 'B1', 'B2'] },
  },
  required: [
    'lemma',
    'part_of_speech',
    'pronunciation_ipa',
    'grammar_notes',
    'usage',
    'sentence_pronunciation',
    'grammar_points',
    'level',
  ],
  additionalProperties: false,
};

export interface AnalyzeAiResult {
  lemma: string;
  part_of_speech: string;
  pronunciation_ipa: string;
  grammar_notes: {
    conjugation_present: string;
    past_participle: string;
    auxiliary: string | null;
    common_mistakes: string[];
  };
  usage: {
    existing_usage_id: string | null;
    label: string;
    meaning_ko: string;
    pattern: string;
  };
  sentence_pronunciation: {
    pronunciation_ipa: string;
    pronunciation_note: string;
  };
  grammar_points: { form: string; meaning: string; example: string }[];
  level: 'A1' | 'A2' | 'B1' | 'B2';
}

// -----------------------------------------------------------------------------
// seed_dictionary: a SEPARATE AI task from classify (above) -- generates
// the lemma's main dictionary senses/idiomatic patterns up front, from
// general knowledge of the word, with NO specific sentence as input. Kept
// as its own prompt/schema (not reused from ANALYZE_SYSTEM_PROMPT) because
// the two tasks have genuinely different inputs/outputs: classify reads
// one sentence and picks/creates ONE usage; this reads just the lemma and
// returns a LIST of senses.
// -----------------------------------------------------------------------------
export const SEED_DICTIONARY_SYSTEM_PROMPT = `You are a French dictionary/teacher assistant building a personal vocabulary entry for a Korean-speaking learner (A2~B2, Montreal). Given ONE French lemma (dictionary form), list its main distinct senses and common idiomatic/semi-auxiliary constructions -- the kind of entry a good learner's dictionary would show, e.g. for "mettre": mettre qqch qqpart (놓다/두다), mettre un vêtement (옷을 입다), mettre qqch dans qqch (넣다), mettre en marche (기기를 작동시키다), mettre à jour (업데이트하다), se mettre à + infinitif (~하기 시작하다), mettre du temps à + infinitif (시간이 걸리다), mettre en place (구축하다), mettre de côté (따로 모아 두다), mettre en pratique (실천하다).

Return 5 to 10 senses, each as one object:
- label: short Korean label.
- meaning_ko: short Korean meaning.
- pattern: the exact construction with correct French grammar terms (e.g. "mettre + groupe nominal (vêtement)", "se mettre à + infinitif"). This MUST be specific enough to distinguish it from every other sense you list -- never list two senses with the same pattern.
- required_complement: one of "nom", "pronom", "infinitif", "clause", "independent" -- what kind of element follows.
- mood_requirement: one of "indicatif", "subjonctif", "conditionnel", "none" -- only meaningful when required_complement is "clause", otherwise "none".
- grammar_explanation_ko: 1-2 Korean sentences explaining this construction.
- common_mistakes_ko: 0-2 short Korean strings, only genuinely common mistakes Korean learners make with THIS specific sense -- empty array if none stand out, never invent one.
- example_fr / example_ko: one natural French example sentence (generic, no real person's facts) and its Korean translation.

Never invent a sense that isn't a real, common use of this word. Never produce Korean phonetic transliteration.`;

export function buildSeedDictionaryUserPrompt(lemma: string): string {
  return JSON.stringify({ lemma });
}

const SEED_SENSE_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    meaning_ko: { type: 'string' },
    pattern: { type: 'string' },
    required_complement: { type: 'string', enum: ['nom', 'pronom', 'infinitif', 'clause', 'independent'] },
    mood_requirement: { type: 'string', enum: ['indicatif', 'subjonctif', 'conditionnel', 'none'] },
    grammar_explanation_ko: { type: 'string' },
    common_mistakes_ko: { type: 'array', items: { type: 'string' } },
    example_fr: { type: 'string' },
    example_ko: { type: 'string' },
  },
  required: [
    'label', 'meaning_ko', 'pattern', 'required_complement', 'mood_requirement',
    'grammar_explanation_ko', 'common_mistakes_ko', 'example_fr', 'example_ko',
  ],
  additionalProperties: false,
};

export const SEED_DICTIONARY_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { senses: { type: 'array', items: SEED_SENSE_SCHEMA } },
  required: ['senses'],
  additionalProperties: false,
};

export interface SeedDictionarySense {
  label: string;
  meaning_ko: string;
  pattern: string;
  required_complement: 'nom' | 'pronom' | 'infinitif' | 'clause' | 'independent';
  mood_requirement: 'indicatif' | 'subjonctif' | 'conditionnel' | 'none';
  grammar_explanation_ko: string;
  common_mistakes_ko: string[];
  example_fr: string;
  example_ko: string;
}
