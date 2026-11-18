-- =============================================================================
-- Migration: 0012_fix_max_output_tokens
-- Purpose  : Root-cause fix for a real production error:
--              SyntaxError: Unterminated string in JSON at position 3044
--
-- ai_rate_limits.max_output_tokens defaulted to 1024 (set in
-- 0002_ai_usage_and_budget.sql), and analyze-batch passed that value
-- straight through as OpenAI's `max_tokens` regardless of how many
-- sentences were in the chunk. Each result item needs ~9 fields of
-- Korean/French text; a chunk of 15-20 sentences needs far more than
-- 1024 tokens to finish. OpenAI stopped generating mid-string
-- (finish_reason: 'length') and the truncated text is not valid JSON --
-- hence "Unterminated string".
--
-- analyze-batch (code change, separate from this migration) now computes
-- its actual request's max_tokens from the chunk size, capped at 4000.
-- This raises the configured ceiling so that computation is never
-- clamped back down to the old 1024 value. Existing rows are updated too
-- so this takes effect without each user needing a fresh row.
-- =============================================================================

alter table public.ai_rate_limits alter column max_output_tokens set default 4000;
update public.ai_rate_limits set max_output_tokens = 4000 where max_output_tokens = 1024;
