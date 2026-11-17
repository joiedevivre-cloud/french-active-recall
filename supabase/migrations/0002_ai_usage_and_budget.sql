-- =============================================================================
-- Migration: 0002_ai_usage_and_budget
-- Purpose  : AI cost/abuse protection -- rate limits, budget tracking, single
--            global kill switch, single-in-flight-request lock.
--
-- These tables are written to ONLY by Edge Functions using the service role
-- key (which bypasses RLS). RLS below intentionally has no INSERT/UPDATE/
-- DELETE policies for authenticated/anon users -- the client can at most be
-- given a read-only policy on its own usage row (added in 0003).
--
-- Source: Claude_프랑스어앱_개발보안지시서.docx, "가장 중요한 요구사항" section:
--   - daily: 30 expression analyses, 5 conversation sessions, 10 turns/session,
--     15 min speech recognition, 1 concurrent request per user (defaults)
--   - daily AI budget ~$0.50, monthly ~$5 (defaults)
--   - server-side atomic reservation before each call, settle after
--   - global AI kill switch that stops all AI calls but leaves expression
--     save / existing review flows working
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ai_system_config -- singleton row: global kill switch + default budgets
-- -----------------------------------------------------------------------------
create table public.ai_system_config (
  id                  boolean primary key default true check (id = true), -- enforces a single row
  ai_enabled          boolean not null default true,
  daily_budget_usd    numeric(10, 4) not null default 0.50,
  monthly_budget_usd  numeric(10, 4) not null default 5.00,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users(id)
);

comment on table public.ai_system_config is 'Single row (id always true). ai_enabled = false is the kill switch: Edge Functions must check this before any AI call and refuse with a clear error if false. Flipping it does not touch expressions/review_states/review_attempts, so saving and reviewing keep working.';

insert into public.ai_system_config (id) values (true);

-- -----------------------------------------------------------------------------
-- ai_rate_limits -- per-user default limits (overridable per user for tuning)
-- -----------------------------------------------------------------------------
create table public.ai_rate_limits (
  user_id                       uuid primary key references auth.users(id) on delete cascade,
  daily_expression_analyses     int not null default 30,
  daily_conversation_sessions   int not null default 5,
  max_turns_per_session         int not null default 10,
  daily_speech_recognition_sec  int not null default 900, -- 15 minutes
  max_concurrent_requests       int not null default 1,
  max_input_chars               int not null default 2000,
  max_output_tokens             int not null default 1024,
  allowed_models                text[] not null default array['gpt-4o-mini'],
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

comment on table public.ai_rate_limits is 'Row is created lazily (upsert) on a user''s first AI request, seeded from these defaults. Edge Functions read this row to enforce per-request and per-day caps -- never hardcode limits in the function.';

create trigger trg_ai_rate_limits_updated_at
  before update on public.ai_rate_limits
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- ai_daily_usage -- atomic per-user, per-day counters + running cost
-- -----------------------------------------------------------------------------
create table public.ai_daily_usage (
  user_id                    uuid not null references auth.users(id) on delete cascade,
  usage_date                 date not null default current_date,
  expression_analyses_count  int not null default 0,
  conversation_sessions_count int not null default 0,
  conversation_turns_count   int not null default 0,
  speech_recognition_seconds int not null default 0,
  estimated_cost_usd         numeric(10, 6) not null default 0,
  updated_at                 timestamptz not null default now(),

  primary key (user_id, usage_date)
);

comment on table public.ai_daily_usage is 'Updated with an atomic UPSERT ... ON CONFLICT DO UPDATE SET x = x + delta inside the Edge Function, in the same transaction as the cost reservation. This is what daily rate limits and the daily budget are checked against.';

create index idx_ai_daily_usage_date on public.ai_daily_usage (usage_date);

-- -----------------------------------------------------------------------------
-- ai_monthly_usage -- aggregate cost per calendar month, for the monthly budget
-- -----------------------------------------------------------------------------
create table public.ai_monthly_usage (
  usage_month        date not null, -- always the 1st of the month, e.g. 2026-11-01
  user_id            uuid not null references auth.users(id) on delete cascade,
  estimated_cost_usd numeric(10, 6) not null default 0,
  updated_at         timestamptz not null default now(),

  primary key (usage_month, user_id)
);

comment on table public.ai_monthly_usage is 'Updated alongside ai_daily_usage in the same Edge Function transaction. Checked against ai_system_config.monthly_budget_usd (global) and can also be summed across all users for a project-wide monthly total.';

-- -----------------------------------------------------------------------------
-- ai_usage_log -- append-only ledger, one row per AI call (audit + cost calc)
-- -----------------------------------------------------------------------------
create table public.ai_usage_log (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  feature            text not null check (feature in (
                        'expression_analysis', 'conversation', 'stt', 'tts', 'ocr'
                      )),
  model              text not null,
  input_tokens       int,
  output_tokens      int,
  audio_seconds       numeric(8, 2),
  estimated_cost_usd numeric(10, 6) not null default 0,
  status             text not null check (status in ('reserved', 'completed', 'failed', 'rejected')),
  rejection_reason   text, -- e.g. 'daily_limit_exceeded', 'budget_exceeded', 'kill_switch', 'invalid_jwt'
  created_at         timestamptz not null default now()
);

comment on table public.ai_usage_log is 'Append-only audit trail. A row is inserted with status=reserved before the call (cost reservation), then updated to completed/failed after. Rejected requests (limit/budget/kill-switch/auth failures) are also logged here for anomaly monitoring -- this is the "이상 사용 감시" data source. This table never contains the AI API key.';

create index idx_ai_usage_log_user_created_at
  on public.ai_usage_log (user_id, created_at desc);

create index idx_ai_usage_log_status
  on public.ai_usage_log (status, created_at desc);

-- -----------------------------------------------------------------------------
-- ai_active_requests -- enforces "max 1 concurrent AI request per user"
-- -----------------------------------------------------------------------------
create table public.ai_active_requests (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  started_at timestamptz not null default now()
);

comment on table public.ai_active_requests is 'Edge Function inserts a row at the start of an AI call and deletes it in a finally-equivalent block when done. The primary key makes a second concurrent request for the same user fail the INSERT with a unique-violation, which the function turns into a 429. Also sweep rows older than e.g. 2 minutes (crashed/timed-out request) before treating an INSERT failure as a real concurrency violation.';
