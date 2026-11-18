-- =============================================================================
-- Migration: 0017_detailed_analysis_v3_tokens
-- Purpose  : detailed-v3 analysis (Construction grammaticale cards with
--            required complement / mood / preposition rule, alternatives,
--            structure_components, sentence_error vs learning_point) outputs
--            roughly 2.5x more tokens for ONE sentence than v2. The
--            per-user ceiling ai_rate_limits.max_output_tokens (4000 since
--            0012) would truncate it mid-JSON -- the exact "Unterminated
--            string in JSON" failure 0012 fixed. Raise it to 8000.
--
-- Cost impact: the light/bulk path is still hard-capped at 4000 in code
-- (MAX_TOTAL_OUTPUT_TOKENS), so only the single-sentence detailed request
-- can use the extra room: ~5,700 output tokens on gpt-4o-mini ≈ $0.0035
-- per detailed analysis. Daily/monthly budget caps are unchanged.
--
-- Only rows still at the previous default (4000) are raised -- a row
-- someone set by hand to a different value is left untouched. No data
-- is deleted; detailed_analysis stays jsonb, so v1/v2 cached analyses
-- remain valid and keep rendering (new v3 fields are optional in the UI).
--
-- Run this BEFORE deploying the updated analyze-batch function.
-- =============================================================================

alter table public.ai_rate_limits alter column max_output_tokens set default 8000;
update public.ai_rate_limits set max_output_tokens = 8000 where max_output_tokens = 4000;

comment on column public.expressions.detailed_analysis is 'Structured detailed analysis (analysis_version: detailed-v1/v2/v3). v3 adds grammar_points[].{meaning_ko, required_complement, mood_requirement, preposition_rule, form_in_sentence, incorrect_example, alternatives, learning_tips}, structure_components, vocabulary[].{sentence_error, learning_point}. Older versions remain valid -- every v3 field is optional when rendering.';
