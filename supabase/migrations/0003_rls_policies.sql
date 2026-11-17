-- =============================================================================
-- Migration: 0003_rls_policies
-- Purpose  : Row Level Security for every table. All client access is scoped
--            to auth.uid(); Edge Functions use the service role key, which
--            bypasses RLS entirely, so AI-usage/budget tables deliberately
--            get no client write policies.
--
-- IMPORTANT (security doc requirement): auth.uid() here is resolved by
-- Postgres from the JWT that PostgREST/Supabase already verified -- it is
-- never a client-supplied value. Edge Functions must apply the same rule:
-- always take the user id from the verified JWT's `sub` claim, never from a
-- request body/query param.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- user_settings
-- -----------------------------------------------------------------------------
alter table public.user_settings enable row level security;

create policy "user_settings_select_own"
  on public.user_settings for select
  using (auth.uid() = user_id);

create policy "user_settings_insert_own"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

create policy "user_settings_update_own"
  on public.user_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No delete policy: settings are deleted only via the user_id FK cascade
-- when the auth.users row itself is deleted.

-- -----------------------------------------------------------------------------
-- expressions
-- -----------------------------------------------------------------------------
alter table public.expressions enable row level security;

create policy "expressions_select_own"
  on public.expressions for select
  using (auth.uid() = user_id);

create policy "expressions_insert_own"
  on public.expressions for insert
  with check (auth.uid() = user_id);

create policy "expressions_update_own"
  on public.expressions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "expressions_delete_own"
  on public.expressions for delete
  using (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- expression_examples (no user_id column -- scoped via parent expression)
-- -----------------------------------------------------------------------------
alter table public.expression_examples enable row level security;

create policy "expression_examples_select_own"
  on public.expression_examples for select
  using (exists (
    select 1 from public.expressions e
    where e.id = expression_examples.expression_id
      and e.user_id = auth.uid()
  ));

create policy "expression_examples_insert_own"
  on public.expression_examples for insert
  with check (exists (
    select 1 from public.expressions e
    where e.id = expression_examples.expression_id
      and e.user_id = auth.uid()
  ));

create policy "expression_examples_update_own"
  on public.expression_examples for update
  using (exists (
    select 1 from public.expressions e
    where e.id = expression_examples.expression_id
      and e.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.expressions e
    where e.id = expression_examples.expression_id
      and e.user_id = auth.uid()
  ));

create policy "expression_examples_delete_own"
  on public.expression_examples for delete
  using (exists (
    select 1 from public.expressions e
    where e.id = expression_examples.expression_id
      and e.user_id = auth.uid()
  ));

-- -----------------------------------------------------------------------------
-- review_states
-- -----------------------------------------------------------------------------
alter table public.review_states enable row level security;

create policy "review_states_select_own"
  on public.review_states for select
  using (auth.uid() = user_id);

create policy "review_states_insert_own"
  on public.review_states for insert
  with check (auth.uid() = user_id);

create policy "review_states_update_own"
  on public.review_states for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "review_states_delete_own"
  on public.review_states for delete
  using (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- review_attempts (append-only from the client's perspective: no update/delete)
-- -----------------------------------------------------------------------------
alter table public.review_attempts enable row level security;

create policy "review_attempts_select_own"
  on public.review_attempts for select
  using (auth.uid() = user_id);

create policy "review_attempts_insert_own"
  on public.review_attempts for insert
  with check (auth.uid() = user_id);

-- No update/delete policy: review history is append-only. Correcting a
-- misrecognized voice transcript happens by inserting a new attempt, not by
-- mutating the original record.

-- -----------------------------------------------------------------------------
-- conversation_sessions
-- -----------------------------------------------------------------------------
alter table public.conversation_sessions enable row level security;

create policy "conversation_sessions_select_own"
  on public.conversation_sessions for select
  using (auth.uid() = user_id);

create policy "conversation_sessions_insert_own"
  on public.conversation_sessions for insert
  with check (auth.uid() = user_id);

create policy "conversation_sessions_update_own"
  on public.conversation_sessions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "conversation_sessions_delete_own"
  on public.conversation_sessions for delete
  using (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- conversation_turns (no user_id column -- scoped via parent session)
-- -----------------------------------------------------------------------------
alter table public.conversation_turns enable row level security;

create policy "conversation_turns_select_own"
  on public.conversation_turns for select
  using (exists (
    select 1 from public.conversation_sessions s
    where s.id = conversation_turns.session_id
      and s.user_id = auth.uid()
  ));

create policy "conversation_turns_insert_own"
  on public.conversation_turns for insert
  with check (exists (
    select 1 from public.conversation_sessions s
    where s.id = conversation_turns.session_id
      and s.user_id = auth.uid()
  ));

create policy "conversation_turns_delete_own"
  on public.conversation_turns for delete
  using (exists (
    select 1 from public.conversation_sessions s
    where s.id = conversation_turns.session_id
      and s.user_id = auth.uid()
  ));

-- No update policy: turns are immutable once written; only insert/select/delete.

-- -----------------------------------------------------------------------------
-- user_streaks
-- -----------------------------------------------------------------------------
alter table public.user_streaks enable row level security;

create policy "user_streaks_select_own"
  on public.user_streaks for select
  using (auth.uid() = user_id);

create policy "user_streaks_insert_own"
  on public.user_streaks for insert
  with check (auth.uid() = user_id);

create policy "user_streaks_update_own"
  on public.user_streaks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- AI usage / budget / kill-switch tables: deny-all for client roles.
-- RLS is enabled with NO policies for anon/authenticated, so PostgREST access
-- is fully blocked. Edge Functions use the service role key, which bypasses
-- RLS regardless of these policies -- that is the only intended write path.
-- -----------------------------------------------------------------------------
alter table public.ai_system_config  enable row level security;
alter table public.ai_rate_limits    enable row level security;
alter table public.ai_daily_usage    enable row level security;
alter table public.ai_monthly_usage  enable row level security;
alter table public.ai_usage_log      enable row level security;
alter table public.ai_active_requests enable row level security;

-- Optional, narrow read-only exception: let a user see their own usage/limits
-- in Settings (e.g. "17/30 analyses used today"). Still no insert/update/
-- delete from the client -- only Edge Functions (service role) write these.
create policy "ai_rate_limits_select_own"
  on public.ai_rate_limits for select
  using (auth.uid() = user_id);

create policy "ai_daily_usage_select_own"
  on public.ai_daily_usage for select
  using (auth.uid() = user_id);

create policy "ai_monthly_usage_select_own"
  on public.ai_monthly_usage for select
  using (auth.uid() = user_id);

-- ai_system_config, ai_usage_log, ai_active_requests: no client policies at
-- all, including select -- these are operational/audit tables only.
