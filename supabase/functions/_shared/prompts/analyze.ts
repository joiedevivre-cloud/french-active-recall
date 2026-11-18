// Shared prompt for the analyze-lemma Edge Function AND
// scripts/backfill-analysis.ts (service-role backfill) -- both must send
// the exact same prompt/schema, so this lives in one place neither imports
// is allowed to diverge it. Bump PROMPT_VERSION whenever the prompt text or
// schema changes; expression_analysis.prompt_version records which version
// produced a given row.
export const PROMPT_VERSION = 'analyze-v1';

export const ANALYZE_SYSTEM_PROMPT = `You are a French teacher helping a Korean-speaking learner (studying in Montreal, A2~B2 level) build a personal "lemma dictionary" from sentences they encountered.

Given ONE French sentence/expression and the user's EXISTING lemmas+usages for its key word (if any), identify:

1. lemma: the dictionary/infinitive form of the single most important word in the sentence (usually the main verb, e.g. "mettre" for "Il a mis la table", or a key noun/expression if there's no notable verb).
2. part_of_speech: e.g. "verbe", "nom", "expression".
3. pronunciation_ipa: IPA for the lemma itself (dictionary form), e.g. "/mɛtʀ/".
4. pronunciation_ko: Korean-approximation pronunciation of the lemma, e.g. "메트ㄹ".
5. pronunciation_note: 0-1 short Korean sentence on a tricky sound, or "" if nothing notable.
6. grammar_notes: {conjugation_present: a few key present-tense forms as one short string, past_participle, auxiliary ("avoir"/"être"/null if not a verb), common_mistakes: 0-3 short Korean strings}.
7. usage: which DISTINCT usage/sense of this lemma this specific sentence demonstrates (e.g. for "mettre": "놓다/두다" vs "옷을 입다" vs "기기를 켜다" vs "se mettre à" vs "mettre en place" are different usages). If the EXISTING usages list already contains one that matches, SET existing_usage_id to its id and reuse its exact label/meaning_en/pattern rather than inventing a near-duplicate. Only invent a new usage (existing_usage_id: null) when none of the existing ones truly fit.
   - label: short Korean label for this usage (e.g. "옷을 입다").
   - meaning_en: short English gloss.
   - pattern: the syntactic pattern, e.g. "mettre + vêtement" or "se mettre à + infinitif".
8. sentence_pronunciation: {pronunciation_ko: Korean-approximation of THIS WHOLE SENTENCE (not just the lemma), pronunciation_liaison: which liaisons occur in this sentence, as a short string (e.g. "les_amis -> 레자미"), or "" if none, pronunciation_note: 0-1 short Korean note, or ""}.
9. grammar_points: 1 to 3 objects {form, meaning, example} -- the actual grammar point(s) in THIS sentence (tense/mood/agreement/preposition choice), anchored to this sentence, not a generic definition. example is a different French sentence using the same point.
10. level: your best CEFR estimate for this sentence, one of A1/A2/B1/B2.

Never invent facts about the sentence that aren't there. Return existing_usage_id as null if there is no existing-usages list or none genuinely matches.`;

export interface ExistingUsageContext {
  id: string;
  label: string;
  meaning_en: string | null;
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
    pronunciation_ko: { type: 'string' },
    pronunciation_note: { type: 'string' },
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
        meaning_en: { type: 'string' },
        pattern: { type: 'string' },
      },
      required: ['existing_usage_id', 'label', 'meaning_en', 'pattern'],
      additionalProperties: false,
    },
    sentence_pronunciation: {
      type: 'object',
      properties: {
        pronunciation_ko: { type: 'string' },
        pronunciation_liaison: { type: 'string' },
        pronunciation_note: { type: 'string' },
      },
      required: ['pronunciation_ko', 'pronunciation_liaison', 'pronunciation_note'],
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
    'pronunciation_ko',
    'pronunciation_note',
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
  pronunciation_ko: string;
  pronunciation_note: string;
  grammar_notes: {
    conjugation_present: string;
    past_participle: string;
    auxiliary: string | null;
    common_mistakes: string[];
  };
  usage: {
    existing_usage_id: string | null;
    label: string;
    meaning_en: string;
    pattern: string;
  };
  sentence_pronunciation: {
    pronunciation_ko: string;
    pronunciation_liaison: string;
    pronunciation_note: string;
  };
  grammar_points: { form: string; meaning: string; example: string }[];
  level: 'A1' | 'A2' | 'B1' | 'B2';
}
