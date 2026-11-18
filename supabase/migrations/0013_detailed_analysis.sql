-- =============================================================================
-- Migration: 0013_detailed_analysis
-- Purpose  : Structured B1~B2 analysis for the expression detail screen
--            (sentence structure, grammar points, word-by-word notes,
--            confusable-expression comparisons, two fresh example
--            sentences) + a proper analyzing/pending state split so
--            "AI 분석 중..." stops meaning "maybe forever".
--
-- Purely additive: no existing column/table is altered destructively, no
-- row is deleted. Existing 'pending'/'completed'/'failed'/'skipped' rows
-- keep their current meaning.
-- =============================================================================

alter table public.expressions
  add column detailed_analysis jsonb,
  add column analyzed_at timestamptz,
  add column analysis_version text,
  add column analysis_requested_at timestamptz,
  add column meaning_ko_user_edited boolean not null default false;

comment on column public.expressions.detailed_analysis is 'Structured B1~B2 analysis: {sentence_structure, grammar_points[], vocabulary[], common_mistakes[], similar_expressions[], example_sentences[]}. One JSON blob because it is always read/written as a whole and never queried by its internal fields -- normalizing this into separate tables would add joins for no benefit.';
comment on column public.expressions.analysis_version is 'e.g. "detailed-v1". Lets the prompt/schema change later without having to guess which rows used the old shape.';
comment on column public.expressions.analysis_requested_at is 'Stamped by the caller right before invoking analyze-batch, BEFORE the status flips to analyzing. The client treats an analyzing row whose request is older than ~90s as stalled (no response ever came back) and offers a retry instead of an infinite spinner -- see src/features/ai-batch/staleAnalysis.ts.';
comment on column public.expressions.meaning_ko_user_edited is 'Set true whenever the USER (not AI) edits meaning_ko. A later re-analysis then never overwrites it -- see applyAnalysisResult.ts.';

-- 'analyzing' is new: distinguishes "never requested" (pending) from
-- "a request is actually in flight" (analyzing). Before this, both cases
-- showed as the same "AI 분석 중..." label with no way to tell a stuck
-- request from one that was simply never started.
alter table public.expressions drop constraint if exists expressions_ai_analysis_status_check;
alter table public.expressions add constraint expressions_ai_analysis_status_check
  check (ai_analysis_status in ('pending', 'analyzing', 'completed', 'failed', 'skipped'));
