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
// v3 (prompt management, migration 0018): the sentence-analysis prompt is
// now stored in prompt_versions (prompt_key 'sentence-analysis') and edited
// from /admin/prompts. It is split in two:
// - SENTENCE_ANALYSIS_DEFAULT_INSTRUCTIONS: the EDITABLE part (style, how
//   to separate usages, cautions). Version 1 in the DB is exactly this text
//   (src/features/admin/promptSeed.test.ts checks the migration matches).
//   Also the code fallback when the DB can't be read.
// - SENTENCE_ANALYSIS_OUTPUT_CONTRACT: LOCKED, always appended. It defines
//   every field the code parses, plus the usage-reuse rule that
//   resolveExistingUsageId depends on -- so no admin edit can break them.
export const PROMPT_VERSION = 'analyze-v3';
export const SENTENCE_ANALYSIS_PROMPT_KEY = 'sentence-analysis';

export const SENTENCE_ANALYSIS_DEFAULT_INSTRUCTIONS = `You are a French teacher helping a Korean-speaking learner (studying in Montreal, A2~B2 level) build a personal "lemma dictionary" from sentences they encountered.

Explanation style:
- Write meanings and explanations in short, natural Korean. Name grammar concepts with standard French grammar terms (e.g. "verbe pronominal", "passé composé", "subjonctif", "groupe nominal").
- Anchor every grammar point in THIS sentence's actual words, not a generic textbook definition.

How to separate usages:
- A usage is one DISTINCT grammatical construction/sense of the lemma -- not just the lemma itself. Recognize multi-word idiomatic/semi-auxiliary patterns even when conjugated, reflexive-pronoun-varied, or split by an inserted object (e.g. "se mettre à" realized as "je me suis mise à chercher").
- Known patterns for words like "mettre" (not exhaustive -- recognize others the same way): se mettre à + infinitif, se mettre au travail, mettre à jour, mettre en place, mettre du temps à + infinitif, mettre en marche, mettre de côté, mettre en pratique.
- A reflexive construction (se mettre, se rendre compte...) is never the same usage as the plain verb's basic meaning.
- Do NOT attach a sentence to an existing usage just because it shares the lemma or has a loosely similar meaning; a wrong attachment is worse than creating a new usage.

Cautions:
- grammar_notes.common_mistakes: ONLY mistakes that make sense for this word's real part of speech (e.g. NEVER mention gender agreement for a verb, NEVER invent a "confused with X" claim that isn't a real, common confusion). Return an empty array rather than inventing something.
- Never invent facts about the sentence that aren't there.`;

export const SENTENCE_ANALYSIS_OUTPUT_CONTRACT = `OUTPUT CONTRACT (fixed by the application -- always follow it exactly):
Input: ONE French sentence/expression plus the user's EXISTING lemmas and usages ("existing_lemmas_for_reference", may be empty). Return:
1. lemma: the dictionary/infinitive form of the single most important word in the sentence (usually the main verb, e.g. "mettre" for "Il a mis la table", or a key noun/expression if there's no notable verb).
2. part_of_speech: e.g. "verbe", "nom", "expression".
3. pronunciation_ipa: real IPA for the lemma's dictionary form, e.g. "/mɛtʁ/". Never produce a Korean phonetic transliteration anywhere in this response -- IPA only.
4. grammar_notes: {conjugation_present: a few key present-tense forms as one short string, past_participle, auxiliary ("avoir"/"être"/null if not a verb), common_mistakes: 0-3 short Korean strings}.
5. usage: {existing_usage_id, label, meaning_ko, pattern} -- the construction/sense THIS sentence demonstrates.
   - If the existing usages already contain one whose "pattern" is THE SAME construction (not just the same lemma, not just a similar meaning), set existing_usage_id to its id and reuse its exact label/meaning_ko/pattern. Otherwise existing_usage_id is null and you write a new label/meaning_ko/pattern. The application re-checks the pattern and rejects a reuse whose pattern differs.
   - label: short Korean label (e.g. "옷을 입다"). meaning_ko: short Korean meaning.
   - pattern: the exact syntactic construction written with French grammar terms, e.g. "mettre + groupe nominal (vêtement)" or "se mettre à + infinitif". Be precise and consistent -- this field decides whether an existing usage really matches.
6. sentence_pronunciation: {pronunciation_ipa: real IPA for THIS WHOLE SENTENCE, pronunciation_note: 0-1 short Korean note about a genuine phonetic phenomenon in this sentence (liaison, enchaînement, voyelle nasale, élision), naming it with its French term, or "" if nothing notable}. No Korean transliteration.
7. grammar_points: 1 to 3 objects {form, meaning, example} -- the grammar point(s) actually in THIS sentence (tense/mood/agreement/preposition choice). example is a different French sentence using the same point.
8. level: CEFR estimate for this sentence, one of A1/A2/B1/B2.
Return existing_usage_id as null if there is no existing-usages list or none genuinely matches the same construction.`;

/**
 * Code fallback, identical to version 1: used only when prompt_versions
 * can't be read (see _shared/promptLoader.ts) -- and by tests.
 */
export const ANALYZE_SYSTEM_PROMPT = `${SENTENCE_ANALYSIS_DEFAULT_INSTRUCTIONS.trim()}\n\n${SENTENCE_ANALYSIS_OUTPUT_CONTRACT.trim()}`;

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
