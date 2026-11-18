-- =============================================================================
-- Migration: 0015_writing_practice
-- Purpose  : Active-recall writing/speaking practice on top of the FSRS
--            engine that already exists (review_states/review_attempts,
--            src/lib/fsrs.ts via ts-fsrs) -- this migration extends that
--            engine and adds exercise-generation/grammar-weak-point
--            tracking, it does NOT create a parallel SRS system.
--
-- Purely additive to every existing table: new nullable/defaulted columns
-- and widened CHECK constraints (strict supersets of current allowed
-- values) only. No existing row's meaning changes, no table is dropped
-- or renamed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- C. ai_usage_log.feature bugfix: analyze-lemma (shipped last session)
-- inserts feature='lemma_analysis', which this CHECK never allowed -- that
-- insert has been silently failing (increment_ai_usage is a separate RPC
-- call, so budget tracking itself was never affected, only this audit
-- row). Also adds 'writing_practice' for this migration's new function.
-- -----------------------------------------------------------------------------
alter table public.ai_usage_log drop constraint if exists ai_usage_log_feature_check;
alter table public.ai_usage_log add constraint ai_usage_log_feature_check
  check (feature in ('expression_analysis', 'conversation', 'stt', 'tts', 'ocr', 'lemma_analysis', 'writing_practice'));

-- -----------------------------------------------------------------------------
-- D. writing_exercises -- a cache/pool of AI-generated exercises per
-- (expression, mode). "Relearning with a new sentence, same grammar
-- pattern" = pick an unused row from this pool (or generate one) rather
-- than regenerating/repeating the literal same exercise every time.
-- -----------------------------------------------------------------------------
create table public.writing_exercises (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  expression_id     uuid not null references public.expressions(id) on delete cascade,
  mode              text not null check (mode in ('transform', 'korean_prompt', 'situational', 'speaking')),
  grammar_tags      text[] not null default '{}',
  prompt_ko         text,
  prompt_fr_pattern text,
  scenario_context  jsonb,
  model             text not null,
  prompt_version    text not null,
  content_hash      text not null,
  times_used        int not null default 0,
  created_at        timestamptz not null default now(),

  unique (user_id, expression_id, mode, content_hash)
);

create index idx_writing_exercises_user_expr_mode
  on public.writing_exercises (user_id, expression_id, mode);
create index idx_writing_exercises_grammar_tags
  on public.writing_exercises using gin (grammar_tags);

alter table public.writing_exercises enable row level security;
create policy "writing_exercises_select_own" on public.writing_exercises for select using (auth.uid() = user_id);
create policy "writing_exercises_insert_own" on public.writing_exercises for insert with check (auth.uid() = user_id);
create policy "writing_exercises_update_own" on public.writing_exercises for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- E. grammar_skills -- per-user, per-tag pass rate + recent errors. Never
-- written to by any FSRS scheduling code path -- only read by the client's
-- queue-composition logic to bias which writing exercises get offered.
-- This is a different axis from expressions.pattern_tag (fixed 6-value
-- b2_700-only enum) and from lemmas/lemma_usages (word-sense grouping).
-- -----------------------------------------------------------------------------
create table public.grammar_skills (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  tag               text not null,
  total_attempts    int not null default 0,
  correct_attempts  int not null default 0,
  recent_errors     jsonb not null default '[]'::jsonb, -- bounded to last 10, see record_grammar_attempt
  last_attempted_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (user_id, tag)
);

create trigger trg_grammar_skills_updated_at
  before update on public.grammar_skills
  for each row execute function public.set_updated_at();

alter table public.grammar_skills enable row level security;
create policy "grammar_skills_select_own" on public.grammar_skills for select using (auth.uid() = user_id);
create policy "grammar_skills_insert_own" on public.grammar_skills for insert with check (auth.uid() = user_id);
create policy "grammar_skills_update_own" on public.grammar_skills for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- A. review_attempts: writing/speaking support + idempotency key
-- -----------------------------------------------------------------------------
alter table public.review_attempts
  add column ai_suggested_rating text check (ai_suggested_rating in ('again', 'hard', 'good', 'easy')),
  add column exercise_id uuid references public.writing_exercises(id) on delete set null,
  add column grammar_tags text[] not null default '{}',
  add column client_id uuid;

comment on column public.review_attempts.ai_suggested_rating is 'The AI correction''s suggested FSRS grade -- advisory only. self_rating (the pre-existing column) is the user''s CONFIRMED grade and is the only one that ever reached the scheduler, before and after this migration.';
comment on column public.review_attempts.client_id is 'Idempotency key for confirm_review_grade (below) -- same partial-unique-index idiom as expressions.client_id, so a retried submission can never double-apply an FSRS rep.';

create unique index uq_review_attempts_user_client_id
  on public.review_attempts (user_id, client_id)
  where client_id is not null;

create index idx_review_attempts_exercise_id
  on public.review_attempts (exercise_id)
  where exercise_id is not null;

-- New `mode` column: distinguishes the 4 new writing/speaking exercise
-- modes from the existing attempt_type values. Deliberately NOT folded
-- into attempt_type (whose existing 'situational'/'voice' reserved
-- values predate this feature and don't line up 1:1 with it, and 3
-- existing attempt_type values already depend on its current meaning).
alter table public.review_attempts add column mode text;
update public.review_attempts
  set mode = case when attempt_type = 'fill_blank' then 'fill_blank' else 'meaning_recall' end
  where mode is null;
alter table public.review_attempts alter column mode set not null;
alter table public.review_attempts alter column mode set default 'meaning_recall';
alter table public.review_attempts add constraint review_attempts_mode_check
  check (mode in ('meaning_recall', 'fill_blank', 'transform', 'korean_prompt', 'situational', 'speaking'));

-- attempt_type itself only grows a 'writing'/'speaking' value -- an
-- extension of its original meaning ("what kind of recall was this"),
-- additive, no row's existing value changes.
alter table public.review_attempts drop constraint if exists review_attempts_attempt_type_check;
alter table public.review_attempts add constraint review_attempts_attempt_type_check
  check (attempt_type in ('meaning_recall', 'fill_blank', 'situational', 'voice', 'b2_quiz', 'ecoute', 'shadowing', 'writing', 'speaking'));

-- -----------------------------------------------------------------------------
-- B. review_states: retrievability snapshot (display-only, like
-- consecutive_correct already is -- never read back into FSRS scheduling)
-- -----------------------------------------------------------------------------
alter table public.review_states add column last_retrievability numeric;
comment on column public.review_states.last_retrievability is 'ts-fsrs get_retrievability() snapshot taken at the moment of the last confirmed review -- an estimate "as of last review", not live. Used for dashboard averages without re-running FSRS math per card on every load. For a live-now estimate on the few cards actually rendered, use estimateCurrentRetrievability() in src/lib/fsrs.ts instead.';

-- -----------------------------------------------------------------------------
-- F. user_settings: writing/speaking daily volumes + desired retention
-- -----------------------------------------------------------------------------
alter table public.user_settings
  add column daily_writing_target int not null default 5 check (daily_writing_target between 0 and 30),
  add column daily_speaking_target int not null default 3 check (daily_speaking_target between 0 and 30),
  add column desired_retention numeric not null default 0.9 check (desired_retention > 0 and desired_retention <= 1);

comment on column public.user_settings.desired_retention is 'Fed into ts-fsrs generatorParameters({ request_retention }) via src/lib/fsrs.ts''s optional requestRetention param. Default 0.9 matches ts-fsrs''s own default -- existing behavior is unchanged until a user changes this in settings.';

-- -----------------------------------------------------------------------------
-- G. ai_rate_limits / ai_daily_usage: writing-practice-specific counters,
-- kept separate from expression_analyses_count so the two features' daily
-- caps can be reasoned about independently.
-- -----------------------------------------------------------------------------
alter table public.ai_rate_limits
  add column daily_writing_generations int not null default 40,
  add column daily_writing_corrections int not null default 40;

alter table public.ai_daily_usage
  add column writing_generations_count int not null default 0,
  add column writing_corrections_count int not null default 0;

-- increment_ai_usage gains two new optional counters. Must be dropped and
-- recreated (not just "create or replace") with the OLD signature first,
-- otherwise Postgres creates a second overloaded function with the same
-- name instead of replacing it -- which would make a future named-argument
-- RPC call from analyze-batch/analyze-lemma ambiguous between the two
-- overloads. Dropping first guarantees exactly one function named
-- increment_ai_usage exists afterward, so every existing call site
-- (which only ever passes p_user_id/p_cost_usd/p_expression_analyses)
-- keeps working unmodified -- the two new params simply default to 0.
drop function if exists public.increment_ai_usage(uuid, numeric, int, int, int, int);

create function public.increment_ai_usage(
  p_user_id uuid,
  p_cost_usd numeric,
  p_expression_analyses int default 0,
  p_conversation_sessions int default 0,
  p_conversation_turns int default 0,
  p_speech_seconds int default 0,
  p_writing_generations int default 0,
  p_writing_corrections int default 0
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
    conversation_turns_count, speech_recognition_seconds, writing_generations_count,
    writing_corrections_count, estimated_cost_usd
  )
  values (
    p_user_id, v_today, p_expression_analyses, p_conversation_sessions, p_conversation_turns,
    p_speech_seconds, p_writing_generations, p_writing_corrections, p_cost_usd
  )
  on conflict (user_id, usage_date) do update set
    expression_analyses_count   = ai_daily_usage.expression_analyses_count + excluded.expression_analyses_count,
    conversation_sessions_count = ai_daily_usage.conversation_sessions_count + excluded.conversation_sessions_count,
    conversation_turns_count    = ai_daily_usage.conversation_turns_count + excluded.conversation_turns_count,
    speech_recognition_seconds  = ai_daily_usage.speech_recognition_seconds + excluded.speech_recognition_seconds,
    writing_generations_count   = ai_daily_usage.writing_generations_count + excluded.writing_generations_count,
    writing_corrections_count   = ai_daily_usage.writing_corrections_count + excluded.writing_corrections_count,
    estimated_cost_usd          = ai_daily_usage.estimated_cost_usd + excluded.estimated_cost_usd,
    updated_at                  = now();

  insert into public.ai_monthly_usage (usage_month, user_id, estimated_cost_usd)
  values (v_month, p_user_id, p_cost_usd)
  on conflict (usage_month, user_id) do update set
    estimated_cost_usd = ai_monthly_usage.estimated_cost_usd + excluded.estimated_cost_usd,
    updated_at          = now();
end;
$$;

revoke execute on function public.increment_ai_usage(uuid, numeric, int, int, int, int, int, int) from public, anon, authenticated;
grant execute on function public.increment_ai_usage(uuid, numeric, int, int, int, int, int, int) to service_role;

-- -----------------------------------------------------------------------------
-- E (cont.). record_grammar_attempt -- security invoker (ordinary RLS
-- applies via auth.uid(), unlike increment_ai_usage above): routine
-- per-user bookkeeping the authenticated client calls directly after an
-- AI correction, not a budget/audit table that needs service-role
-- isolation. Appends to recent_errors, keeping only the most recent 10.
-- -----------------------------------------------------------------------------
create or replace function public.record_grammar_attempt(
  p_tag text,
  p_correct boolean,
  p_note_ko text default null,
  p_attempt_id uuid default null
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing jsonb;
  v_combined jsonb;
begin
  select recent_errors into v_existing from public.grammar_skills where user_id = v_user_id and tag = p_tag;

  if p_correct then
    v_combined := coalesce(v_existing, '[]'::jsonb);
  else
    select coalesce(jsonb_agg(elem), '[]'::jsonb) into v_combined
    from (
      select elem from jsonb_array_elements(
        coalesce(v_existing, '[]'::jsonb) || jsonb_build_array(
          jsonb_build_object('attempt_id', p_attempt_id, 'note_ko', p_note_ko, 'created_at', now())
        )
      ) elem
      order by (elem->>'created_at')::timestamptz desc
      limit 10
    ) t;
  end if;

  insert into public.grammar_skills (user_id, tag, total_attempts, correct_attempts, recent_errors, last_attempted_at)
  values (v_user_id, p_tag, 1, case when p_correct then 1 else 0 end, v_combined, now())
  on conflict (user_id, tag) do update set
    total_attempts    = grammar_skills.total_attempts + 1,
    correct_attempts  = grammar_skills.correct_attempts + (case when p_correct then 1 else 0 end),
    recent_errors     = v_combined,
    last_attempted_at = now();
end;
$$;

revoke execute on function public.record_grammar_attempt(text, boolean, text, uuid) from public, anon;
grant execute on function public.record_grammar_attempt(text, boolean, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- H. confirm_review_grade -- security invoker, idempotent via
-- review_attempts.client_id. Replaces TodayReview.tsx's current two
-- separate non-transactional writes (review_states.update then
-- review_attempts.insert) with one atomic, retry-safe call. FSRS math
-- itself stays entirely client-side (src/lib/fsrs.ts's scheduleReview,
-- unchanged) -- this function only persists what the client already
-- computed, exactly like the two direct writes it replaces did.
-- -----------------------------------------------------------------------------
create or replace function public.confirm_review_grade(
  p_client_id uuid,
  p_review_state_id uuid,
  p_expression_id uuid,
  p_rating text,
  p_attempt_type text,
  p_mode text,
  p_new_review_state jsonb,
  p_exercise_id uuid default null,
  p_response_text text default null,
  p_response_time_ms int default null,
  p_hint_used boolean default false,
  p_ai_suggested_rating text default null,
  p_ai_feedback jsonb default null,
  p_grammar_tags text[] default '{}'
) returns table (attempt_id uuid, already_applied boolean)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt_id uuid;
begin
  select id into v_attempt_id
  from public.review_attempts
  where user_id = v_user_id and client_id = p_client_id;

  if v_attempt_id is not null then
    return query select v_attempt_id, true;
    return;
  end if;

  update public.review_states set
    due_at               = (p_new_review_state ->> 'due_at')::timestamptz,
    stability            = (p_new_review_state ->> 'stability')::numeric,
    difficulty           = (p_new_review_state ->> 'difficulty')::numeric,
    elapsed_days         = (p_new_review_state ->> 'elapsed_days')::numeric,
    scheduled_days       = (p_new_review_state ->> 'scheduled_days')::numeric,
    reps                 = (p_new_review_state ->> 'reps')::int,
    lapses               = (p_new_review_state ->> 'lapses')::int,
    state                = p_new_review_state ->> 'state',
    last_reviewed_at     = (p_new_review_state ->> 'last_reviewed_at')::timestamptz,
    last_retrievability  = coalesce((p_new_review_state ->> 'last_retrievability')::numeric, last_retrievability),
    consecutive_correct  = case when p_rating = 'again' then 0 else consecutive_correct + 1 end
  where id = p_review_state_id and user_id = v_user_id;

  if not found then
    raise exception 'review_state_not_found_or_not_owned';
  end if;

  insert into public.review_attempts (
    user_id, expression_id, attempt_type, mode, exercise_id, response_text,
    response_time_ms, hint_used, self_rating, ai_suggested_rating, ai_feedback,
    grammar_tags, client_id
  ) values (
    v_user_id, p_expression_id, p_attempt_type, p_mode, p_exercise_id, p_response_text,
    p_response_time_ms, p_hint_used, p_rating, p_ai_suggested_rating, p_ai_feedback,
    p_grammar_tags, p_client_id
  ) returning id into v_attempt_id;

  return query select v_attempt_id, false;
end;
$$;

revoke execute on function public.confirm_review_grade(uuid, uuid, uuid, text, text, text, jsonb, uuid, text, int, boolean, text, jsonb, text[]) from public, anon;
grant execute on function public.confirm_review_grade(uuid, uuid, uuid, text, text, text, jsonb, uuid, text, int, boolean, text, jsonb, text[]) to authenticated;
