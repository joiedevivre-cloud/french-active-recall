// Pure schema/token-budget logic for analyze-batch's light + detailed
// analysis, pulled out of index.ts so it can be unit-tested from Vitest too
// (see src/features/ai-batch/detailedAnalysisSchema.test.ts, which imports
// this exact file by relative path -- same "one copy, tested where it
// runs" pattern as supabase/functions/_shared/lemmaMatching.ts). No
// Deno-specific syntax here.

// Each result item carries ~9 fields of Korean/French text. A FIXED
// max_tokens regardless of chunk size (the old bug: always 1024,
// whatever ai_rate_limits.max_output_tokens said) meant any chunk bigger
// than ~3-4 sentences could never finish within budget -- OpenAI stops
// generating mid-string (finish_reason: 'length') and the truncated text
// is simply not valid JSON. This is a generous-but-bounded per-item
// estimate, not a tight one; MAX_TOTAL_OUTPUT_TOKENS is a hard ceiling
// independent of whatever a user's ai_rate_limits row says, so a
// misconfigured/very high row can never request an enormous completion.
export const TOKENS_PER_ITEM_ESTIMATE = 350;
// The detailed (core_pattern/sentence_structure/grammar_points/vocabulary/
// common_mistakes/similar_expressions/example_sentences) schema is far
// bigger per item -- gated to exactly 1 sentence per request (see
// MAX_DETAILED_SENTENCES below) specifically so this large per-item cost
// never has to multiply across a chunk. Raised from 1800 -> 2200 when
// core_pattern was added (v2): a new always-populated structured field
// means more output per call, and underestimating this is exactly what
// caused the original "Unterminated string in JSON" truncation bug.
//
// Raised again 2200 -> 5500 for v3 (detailed-v3: Construction rules +
// alternatives per grammar point, structure_components, sentence_error /
// learning_point split): roughly 2.5x the v2 output for a typical B1
// sentence. Still exactly one sentence per request.
export const DETAILED_TOKENS_PER_ITEM_ESTIMATE = 5500;
export const OUTPUT_TOKEN_OVERHEAD = 200;
// Light/bulk ceiling (unchanged).
export const MAX_TOTAL_OUTPUT_TOKENS = 4000;
// Detailed mode has its own, higher hard ceiling: v3's output for ONE
// sentence no longer fits in 4000 tokens, and squeezing it in is exactly
// what reproduces the "Unterminated string in JSON" truncation. gpt-4o-mini
// allows up to 16k output tokens; 8000 leaves ~2300 tokens of headroom
// over the estimate. Still capped by ai_rate_limits.max_output_tokens
// (raised to 8000 by migration 0017 -- run it BEFORE deploying).
export const MAX_DETAILED_OUTPUT_TOKENS = 8000;
export const MAX_DETAILED_SENTENCES = 1;
export const MAX_CHUNK_SIZE = 20;

export function computeMaxOutputTokens(sentenceCount: number, configuredCeiling: number, detailed: boolean): number {
  const perItem = detailed ? DETAILED_TOKENS_PER_ITEM_ESTIMATE : TOKENS_PER_ITEM_ESTIMATE;
  const estimated = sentenceCount * perItem + OUTPUT_TOKEN_OVERHEAD;
  const hardCeiling = detailed ? MAX_DETAILED_OUTPUT_TOKENS : MAX_TOTAL_OUTPUT_TOKENS;
  return Math.min(estimated, hardCeiling, configuredCeiling);
}

export const LIGHT_RESULT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    expression_fr: { type: 'string' },
    corrected_fr: { type: ['string', 'null'] },
    meaning_ko: { type: 'string' },
    grammar_note: { type: 'string' },
    example_fr: { type: 'string' },
    example_translation_ko: { type: 'string' },
    cefr_level: { type: 'string', enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] },
    tags: { type: 'array', items: { type: 'string' } },
    key_phrase: { type: 'string' },
  },
  required: [
    'expression_fr',
    'corrected_fr',
    'meaning_ko',
    'grammar_note',
    'example_fr',
    'example_translation_ko',
    'cefr_level',
    'tags',
    'key_phrase',
  ],
  additionalProperties: false,
};

// v2: the PRIMARY field for detailed analysis -- unlike sentence_structure
// (clause-based, only meaningful for subordinate-clause sentences like
// "il faut que + subjonctif"), this applies to EVERY sentence and exists
// specifically to catch multi-word idiomatic/semi-auxiliary patterns
// (se mettre à + infinitif, avoir beau + infinitif, venir de + infinitif,
// etc.) that a word-by-word vocabulary breakdown misses entirely -- the
// bug this schema change fixes (see README "AI 분석 품질").
export const CORE_PATTERN_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    pattern: { type: 'string' },
    meaning_ko: { type: 'string' },
    matched_form: { type: 'string' },
    explanation_ko: { type: 'string' },
  },
  required: ['pattern', 'meaning_ko', 'matched_form', 'explanation_ko'],
  additionalProperties: false,
};

// Only used when detailed=true (see below) -- a SINGLE sentence at a time.
// Deliberately NOT part of the light/bulk schema: every field here adds a
// lot of Korean-heavy output, and this is exactly the kind of per-item
// cost growth that caused the max_tokens truncation bug when it was
// implicitly applied to a whole multi-sentence chunk. Keeping this gated
// to one sentence per request means the token budget never has to scale
// with chunk size for this schema at all.
export const SENTENCE_STRUCTURE_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    main_clause: { type: 'string' },
    conjunction: { type: 'string' },
    subordinate_clause: { type: 'string' },
    core_structure: { type: 'string' },
    infinitive: { type: 'string' },
    conjugated_form: { type: 'string' },
    mood_explanation: { type: 'string' },
    mood_contrast: { type: 'string' },
    overall_meaning: { type: 'string' },
  },
  required: [
    'main_clause',
    'conjunction',
    'subordinate_clause',
    'core_structure',
    'infinitive',
    'conjugated_form',
    'mood_explanation',
    'mood_contrast',
    'overall_meaning',
  ],
  additionalProperties: false,
};

// v3: common_mistake split in two (README "실제 오류 vs 학습 포인트"):
// - sentence_error: a REAL error in THIS sentence involving this word.
//   Only meaningful when the sentence itself has corrected_fr != null --
//   guardDetailedResult() (src/features/ai-batch/detailedAnalysisGuard.ts)
//   force-clears it otherwise, so a correct sentence can never show a
//   warning (the "fatigue: gender agreement" false-positive bug).
// - learning_point: a general rule worth knowing (shown as a 학습 포인트,
//   never as a warning).
// Legacy rows still carry common_mistake; the UI shows it as a learning point.
export const VOCABULARY_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    word: { type: 'string' },
    part_of_speech: { type: 'string' },
    meaning_ko: { type: 'string' },
    infinitive: { type: ['string', 'null'] },
    tense_or_conjugation: { type: ['string', 'null'] },
    gender_agreement: { type: ['string', 'null'] },
    preposition: { type: ['string', 'null'] },
    sentence_error: { type: ['string', 'null'] },
    learning_point: { type: ['string', 'null'] },
  },
  required: [
    'word', 'part_of_speech', 'meaning_ko', 'infinitive', 'tense_or_conjugation',
    'gender_agreement', 'preposition', 'sentence_error', 'learning_point',
  ],
  additionalProperties: false,
};

// Same enums as lemma_usages.required_complement / mood_requirement
// (migration 0016) -- one vocabulary of construction rules across the
// vocabulary screen and the expression detail screen; the UI turns them
// into French labels via src/lib/grammarTerms.ts complementLabelFr().
export const REQUIRED_COMPLEMENT_ENUM = ['nom', 'pronom', 'infinitif', 'clause', 'independent'];
export const MOOD_REQUIREMENT_ENUM = ['indicatif', 'subjonctif', 'conditionnel', 'none'];
export const REGISTER_ENUM = ['familier', 'courant', 'soutenu'];

export const ALTERNATIVE_SCHEMA = {
  type: 'object',
  properties: {
    expression: { type: 'string' },
    construction: { type: 'string' },
    required_complement: { type: 'string', enum: REQUIRED_COMPLEMENT_ENUM },
    mood_requirement: { type: 'string', enum: MOOD_REQUIREMENT_ENUM },
    meaning_ko: { type: 'string' },
    nuance_ko: { type: 'string' },
    register: { type: 'string', enum: REGISTER_ENUM },
    rewritten_sentence: { type: 'string' },
  },
  required: [
    'expression', 'construction', 'required_complement', 'mood_requirement',
    'meaning_ko', 'nuance_ko', 'register', 'rewritten_sentence',
  ],
  additionalProperties: false,
};

export const INCORRECT_EXAMPLE_SCHEMA = {
  type: ['object', 'null'],
  properties: { fr: { type: 'string' }, reason_ko: { type: 'string' } },
  required: ['fr', 'reason_ko'],
  additionalProperties: false,
};

// v3: a sentence's important grammatical relations, multi-word units kept
// as ONE component (e.g. "me rends compte" -> Verbe pronominal
// "se rendre compte"; "fais des progrès" -> Locution verbale). Applies to
// every sentence, unlike the clause-only legacy sentence_structure.
export const STRUCTURE_COMPONENT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    function_fr: { type: 'string' },
    note_ko: { type: 'string' },
  },
  required: ['text', 'function_fr', 'note_ko'],
  additionalProperties: false,
};

// v3: each grammar point is a full "Construction grammaticale" card --
// what must follow it, which mood, which preposition, a correct example
// (= `example`) and an incorrect one, plus alternatives that say the same
// thing with a different construction. pattern/meaning/example keep their
// v1/v2 meaning so legacy rows and new ones share one renderer.
export const GRAMMAR_POINT_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string' },
    meaning: { type: 'string' },
    example: { type: 'string' },
    meaning_ko: { type: 'string' },
    required_complement: { type: 'string', enum: REQUIRED_COMPLEMENT_ENUM },
    mood_requirement: { type: 'string', enum: MOOD_REQUIREMENT_ENUM },
    preposition_rule: { type: ['string', 'null'] },
    form_in_sentence: { type: 'string' },
    incorrect_example: INCORRECT_EXAMPLE_SCHEMA,
    alternatives: { type: 'array', items: ALTERNATIVE_SCHEMA },
    learning_tips: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'pattern', 'meaning', 'example', 'meaning_ko', 'required_complement', 'mood_requirement',
    'preposition_rule', 'form_in_sentence', 'incorrect_example', 'alternatives', 'learning_tips',
  ],
  additionalProperties: false,
};

export const SIMILAR_EXPRESSION_SCHEMA = {
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'string' }, difference: { type: 'string' } },
  required: ['a', 'b', 'difference'],
  additionalProperties: false,
};

export const EXAMPLE_SENTENCE_SCHEMA = {
  type: 'object',
  properties: { fr: { type: 'string' }, ko: { type: 'string' } },
  required: ['fr', 'ko'],
  additionalProperties: false,
};

export const DETAILED_RESULT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    ...LIGHT_RESULT_ITEM_SCHEMA.properties,
    core_pattern: CORE_PATTERN_SCHEMA,
    sentence_structure: SENTENCE_STRUCTURE_SCHEMA,
    structure_components: { type: 'array', items: STRUCTURE_COMPONENT_SCHEMA },
    grammar_points: { type: 'array', items: GRAMMAR_POINT_SCHEMA },
    vocabulary: { type: 'array', items: VOCABULARY_ITEM_SCHEMA },
    common_mistakes: { type: 'array', items: { type: 'string' } },
    similar_expressions: { type: 'array', items: SIMILAR_EXPRESSION_SCHEMA },
    example_sentences: { type: 'array', items: EXAMPLE_SENTENCE_SCHEMA },
  },
  required: [
    ...LIGHT_RESULT_ITEM_SCHEMA.required,
    'core_pattern',
    'sentence_structure',
    'structure_components',
    'grammar_points',
    'vocabulary',
    'common_mistakes',
    'similar_expressions',
    'example_sentences',
  ],
  additionalProperties: false,
};

export function buildResponseSchema(itemSchema: unknown) {
  return {
    type: 'object',
    properties: { results: { type: 'array', items: itemSchema } },
    required: ['results'],
    additionalProperties: false,
  };
}
