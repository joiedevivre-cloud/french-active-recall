-- =============================================================================
-- Migration: 0001_core_schema
-- Purpose  : Core tables for french-active-recall (expressions, reviews,
--            conversations, user settings). FSRS-based spaced repetition.
--
-- REVIEW BEFORE APPLYING. Do not run against an existing/shared Supabase
-- project without explicit approval. Safe to run on a brand-new, empty
-- Supabase project's SQL editor (or `supabase db push`).
--
-- Source requirements:
--   - CLAUDE_CODE_지시서_french-active-recall.md §12 (table list, indexes)
--   - Claude_프랑스어앱_개발보안지시서.docx (RLS, auth.uid() server-side trust)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists unaccent;   -- accent-insensitive dedup search
create extension if not exists pg_trgm;    -- fuzzy duplicate search

-- unaccent() is STABLE, not IMMUTABLE, so it cannot be used directly inside a
-- generated column. Wrap it in an IMMUTABLE function (standard Postgres trick).
create or replace function public.immutable_unaccent(text)
returns text
language sql
immutable
parallel safe
as $$
  select unaccent('unaccent', $1);
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- user_settings
-- -----------------------------------------------------------------------------
create table public.user_settings (
  user_id                       uuid primary key references auth.users(id) on delete cascade,
  preferred_language            text not null default 'fr' check (preferred_language in ('fr', 'ko')),
  card_display_mode             text not null default 'fr_first' check (card_display_mode in ('fr_first', 'ko_first', 'fr_only')),
  daily_new_limit               int not null default 8  check (daily_new_limit between 1 and 100),
  daily_review_limit            int not null default 15 check (daily_review_limit between 1 and 300),
  review_preferences            jsonb not null default '{}'::jsonb,
  speech_speed                  numeric not null default 1.0 check (speech_speed between 0.5 and 2.0),
  silent_mode                   boolean not null default false,
  dark_mode                     boolean not null default false,
  ai_conversation_daily_minutes int not null default 5 check (ai_conversation_daily_minutes between 1 and 60),
  -- B2 700-sentence module
  b2_daily_target               int not null default 20 check (b2_daily_target between 10 and 50),
  b2_target_date                date,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

comment on table public.user_settings is 'One row per user. Created on first login via app/edge function (not a DB trigger, so the app can seed sensible defaults).';

create trigger trg_user_settings_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- expressions
-- -----------------------------------------------------------------------------
create table public.expressions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,

  -- Offline-first support: client generates this once, server upserts on it
  -- so a flaky sync never creates duplicates. NULL for rows created online.
  client_id               uuid,

  expression_fr           text not null check (length(btrim(expression_fr)) > 0),
  -- Accent/case-insensitive form, used for fast duplicate lookup (see index below).
  expression_fr_normalized text generated always as
    (public.immutable_unaccent(lower(btrim(expression_fr)))) stored,

  lemma                   text,
  meaning_ko              text,
  meanings                jsonb not null default '[]'::jsonb, -- [{meaning_ko, context}, ...] when polysemous
  definition_fr           text,
  part_of_speech          text,
  grammar_note            text,
  related_expressions     jsonb not null default '[]'::jsonb, -- [{expression_fr, meaning_ko}, ...]
  cefr_level              text check (cefr_level in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),

  source_type             text not null default 'manual' check (source_type in (
                             'manual', 'class', 'tv5monde', 'daily_conversation',
                             'ocr', 'voice', 'import_anki', 'import_csv', 'b2_700'
                           )),
  -- Only meaningful when source_type = 'b2_700' (Rimbaud 700-sentence module),
  -- one of the 6 grammar categories from the spec (§10-3).
  pattern_tag             text check (pattern_tag in (
                             'subjonctif', 'conditionnel', 'infinitif_gerondif',
                             'relatif_complexe', 'passe_compose_imparfait',
                             'expression_idiomatique'
                           )),
  original_context        text, -- free text: where/how the user encountered it

  is_favorite              boolean not null default false,
  ai_analysis_status       text not null default 'pending' check (ai_analysis_status in (
                              'pending', 'completed', 'failed', 'skipped'
                            )),

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at               timestamptz -- soft delete; see §11 of the spec for retention policy
);

comment on column public.expressions.client_id is 'Client-generated UUID for offline idempotent upsert. Unique per user (see index). Distinct from id, which is always server-assigned.';
comment on column public.expressions.ai_analysis_status is 'pending = saved but not yet analyzed by AI (e.g. offline or analysis in flight). The raw expression_fr is always user-authored; lemma/definition_fr/meanings/grammar_note/related_expressions/cefr_level are AI-generated and user-editable afterwards.';

create trigger trg_expressions_updated_at
  before update on public.expressions
  for each row execute function public.set_updated_at();

-- One pending client_id per user at a time; once synced it stays for idempotency.
create unique index uq_expressions_user_client_id
  on public.expressions (user_id, client_id)
  where client_id is not null;

-- Recent expressions feed ("오늘 저장한 표현", "최근 저장한 표현 조회")
create index idx_expressions_user_created_at
  on public.expressions (user_id, created_at desc)
  where deleted_at is null;

-- Duplicate detection: exact/accent-insensitive match lookup on save.
create index idx_expressions_user_normalized
  on public.expressions (user_id, expression_fr_normalized)
  where deleted_at is null;

-- Fuzzy duplicate suggestions (optional, for "did you mean this existing card?").
create index idx_expressions_normalized_trgm
  on public.expressions using gin (expression_fr_normalized gin_trgm_ops);

-- Library filters: source, CEFR level, pattern tag, favorites.
create index idx_expressions_user_source_type
  on public.expressions (user_id, source_type)
  where deleted_at is null;

create index idx_expressions_user_pattern_tag
  on public.expressions (user_id, pattern_tag)
  where deleted_at is null and pattern_tag is not null;

create index idx_expressions_user_favorite
  on public.expressions (user_id)
  where deleted_at is null and is_favorite = true;

-- -----------------------------------------------------------------------------
-- expression_examples
-- -----------------------------------------------------------------------------
create table public.expression_examples (
  id              uuid primary key default gen_random_uuid(),
  expression_id   uuid not null references public.expressions(id) on delete cascade,
  sentence_fr     text not null check (length(btrim(sentence_fr)) > 0),
  translation_ko  text,
  is_user_created boolean not null default false, -- false = AI-generated example
  created_at      timestamptz not null default now()
);

create index idx_expression_examples_expression_id
  on public.expression_examples (expression_id);

-- -----------------------------------------------------------------------------
-- review_states  (one row per user+expression, FSRS scheduler state)
-- -----------------------------------------------------------------------------
create table public.review_states (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  expression_id       uuid not null references public.expressions(id) on delete cascade,

  due_at              timestamptz not null default now(),
  stability           numeric not null default 0,
  difficulty          numeric not null default 0,
  elapsed_days        numeric not null default 0,
  scheduled_days      numeric not null default 0,
  reps                int not null default 0,
  lapses              int not null default 0,
  state               text not null default 'new' check (state in ('new', 'learning', 'review', 'relearning')),
  last_reviewed_at     timestamptz,

  -- Display-only "Mastered" badge support (spec §0-1 conflict rule): consecutive
  -- correct reviews with no 'again' rating since the last lapse. This NEVER
  -- overrides the FSRS state itself -- it's purely derived/cached for the UI.
  consecutive_correct int not null default 0,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (user_id, expression_id)
);

comment on table public.review_states is 'FSRS scheduler state, one per expression. Updated only from an explicit review rating (Again/Hard/Good/Easy) coming from review_attempts -- never derived from response_time_ms or AI conversation feedback directly (spec §9 rule).';

create trigger trg_review_states_updated_at
  before update on public.review_states
  for each row execute function public.set_updated_at();

-- "오늘/지금 복습할 표현" queries - the most frequent read in the app.
create index idx_review_states_user_due_at
  on public.review_states (user_id, due_at);

create index idx_review_states_user_state
  on public.review_states (user_id, state);

-- -----------------------------------------------------------------------------
-- review_attempts  (append-only log of every recall attempt)
-- -----------------------------------------------------------------------------
create table public.review_attempts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  expression_id    uuid not null references public.expressions(id) on delete cascade,

  attempt_type     text not null check (attempt_type in (
                      'meaning_recall', 'fill_blank', 'situational', 'voice',
                      'b2_quiz', 'ecoute', 'shadowing'
                    )),
  response_text    text,
  response_time_ms int,
  hint_used        boolean not null default false,
  -- Final FSRS rating the user confirmed for this attempt. response_time_ms /
  -- ai_feedback below are informational only and must never be silently mapped
  -- to a rating by the app (spec §9 rule) -- they can only inform a *suggested*
  -- rating that the user then confirms.
  self_rating      text check (self_rating in ('again', 'hard', 'good', 'easy')),
  ai_feedback      jsonb, -- { meaning_ok, grammar_ok, used_target_expression, notes }

  created_at       timestamptz not null default now()
);

comment on table public.review_attempts is 'Append-only. review_states is the derived scheduler snapshot; this table is the full history used for "자주 틀리는 표현" stats and per-expression review history.';

-- Per-expression review history, most-recent-first.
create index idx_review_attempts_expression_created_at
  on public.review_attempts (expression_id, created_at desc);

-- Per-user activity feed / daily stats aggregation.
create index idx_review_attempts_user_created_at
  on public.review_attempts (user_id, created_at desc);

-- "자주 틀리는 표현" - attempts rated 'again'.
create index idx_review_attempts_user_expression_again
  on public.review_attempts (user_id, expression_id)
  where self_rating = 'again';

-- -----------------------------------------------------------------------------
-- conversation_sessions / conversation_turns
-- -----------------------------------------------------------------------------
create table public.conversation_sessions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  scenario            text not null,
  cefr_level          text check (cefr_level in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  target_expressions  uuid[] not null default '{}',
  started_at          timestamptz not null default now(),
  completed_at        timestamptz,
  -- { expressions_used: [...], expressions_missed: [...], recurring_errors: [...],
  --   better_sentences: [...], next_review_suggestions: [...] }
  summary             jsonb
);

comment on table public.conversation_sessions is 'summary holds only the post-conversation learning digest. Raw turn content in conversation_turns is not kept indefinitely -- see retention note below.';

create index idx_conversation_sessions_user_started_at
  on public.conversation_sessions (user_id, started_at desc);

create table public.conversation_turns (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.conversation_sessions(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);

comment on table public.conversation_turns is 'Security doc requirement: raw AI conversation transcripts are not kept permanently by default. Implement a scheduled cleanup (pg_cron or an Edge Function on a timer) that deletes rows older than N days (e.g. 7) once conversation_sessions.summary has been generated. Document the chosen retention window in README.';

create index idx_conversation_turns_session_id
  on public.conversation_turns (session_id, created_at);

-- -----------------------------------------------------------------------------
-- user_streaks (study streak, cheap to maintain incrementally from the app)
-- -----------------------------------------------------------------------------
create table public.user_streaks (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  current_streak   int not null default 0,
  longest_streak   int not null default 0,
  last_active_date date,
  updated_at       timestamptz not null default now()
);

create trigger trg_user_streaks_updated_at
  before update on public.user_streaks
  for each row execute function public.set_updated_at();
