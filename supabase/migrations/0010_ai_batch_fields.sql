-- =============================================================================
-- Migration: 0010_ai_batch_fields
-- Purpose  : Support the AI batch-analysis feature ("문장 1~100개 붙여넣기 →
--            AI 일괄 분석 → 검토 → 저장").
--
-- 1. expressions gets two new nullable columns -- no existing data touched,
--    purely additive.
-- 2. ai_rate_limits.daily_expression_analyses default raised 30 -> 150.
--    The original 30/day default (security doc) was sized around single
--    quick-add analyses; a single 100-sentence batch alone would blow past
--    it. 150 leaves headroom for a 100-sentence batch plus normal same-day
--    quick-add use, while still being a bounded, adjustable cap (not
--    unlimited). Existing per-user rows are updated too so this takes
--    effect immediately without each user needing a fresh row.
-- =============================================================================

alter table public.expressions
  add column corrected_fr text,
  add column key_phrase text;

comment on column public.expressions.corrected_fr is 'AI-suggested grammatical correction of expression_fr, kept for reference even after the user decides whether to apply it. NULL if AI found no correction needed (or wasn''t run).';
comment on column public.expressions.key_phrase is 'The core phrase/pattern worth memorizing from this expression (e.g. "penser à" for a full example sentence using it), as suggested by batch AI analysis.';

alter table public.ai_rate_limits alter column daily_expression_analyses set default 150;
update public.ai_rate_limits set daily_expression_analyses = 150 where daily_expression_analyses = 30;
