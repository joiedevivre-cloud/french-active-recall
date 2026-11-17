-- =============================================================================
-- Migration: 0005_ai_usage_functions
-- Purpose  : Atomic usage-counter increment for the AI Edge Functions.
--
-- SECURITY: this function takes p_user_id as a plain argument and must NEVER
-- be callable by anon/authenticated roles -- a client could otherwise pass
-- an arbitrary user_id and inflate/zero out someone else's usage counters,
-- or call it directly to fake "free" usage without the Edge Function's rate
-- limit checks running first. Only the Edge Function (service_role) may
-- call it.
-- =============================================================================

create or replace function public.increment_ai_usage(
  p_user_id uuid,
  p_cost_usd numeric,
  p_expression_analyses int default 0,
  p_conversation_sessions int default 0,
  p_conversation_turns int default 0,
  p_speech_seconds int default 0
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := current_date;
  v_month date := date_trunc('month', current_date)::date;
begin
  insert into public.ai_daily_usage (
    user_id, usage_date, expression_analyses_count, conversation_sessions_count,
    conversation_turns_count, speech_recognition_seconds, estimated_cost_usd
  )
  values (p_user_id, v_today, p_expression_analyses, p_conversation_sessions, p_conversation_turns, p_speech_seconds, p_cost_usd)
  on conflict (user_id, usage_date) do update set
    expression_analyses_count   = ai_daily_usage.expression_analyses_count + excluded.expression_analyses_count,
    conversation_sessions_count = ai_daily_usage.conversation_sessions_count + excluded.conversation_sessions_count,
    conversation_turns_count    = ai_daily_usage.conversation_turns_count + excluded.conversation_turns_count,
    speech_recognition_seconds  = ai_daily_usage.speech_recognition_seconds + excluded.speech_recognition_seconds,
    estimated_cost_usd          = ai_daily_usage.estimated_cost_usd + excluded.estimated_cost_usd,
    updated_at                  = now();

  insert into public.ai_monthly_usage (usage_month, user_id, estimated_cost_usd)
  values (v_month, p_user_id, p_cost_usd)
  on conflict (usage_month, user_id) do update set
    estimated_cost_usd = ai_monthly_usage.estimated_cost_usd + excluded.estimated_cost_usd,
    updated_at          = now();
end;
$$;

revoke execute on function public.increment_ai_usage(uuid, numeric, int, int, int, int) from public, anon, authenticated;
grant execute on function public.increment_ai_usage(uuid, numeric, int, int, int, int) to service_role;

-- -----------------------------------------------------------------------------
-- Sweeps crashed/timed-out concurrency locks. Edge Functions call this before
-- trying to acquire ai_active_requests, so a request that died without
-- reaching its `finally` cleanup doesn't permanently lock the user out.
-- -----------------------------------------------------------------------------
create or replace function public.sweep_stale_ai_locks(p_max_age_seconds int default 120)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.ai_active_requests
  where started_at < now() - make_interval(secs => p_max_age_seconds);
$$;

revoke execute on function public.sweep_stale_ai_locks(int) from public, anon, authenticated;
grant execute on function public.sweep_stale_ai_locks(int) to service_role;
