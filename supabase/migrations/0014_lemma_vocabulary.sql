-- =============================================================================
-- Migration: 0014_lemma_vocabulary
-- Purpose  : Word-level (lemma) analysis: groups expressions under a shared
--            key verb/word and usage (e.g. "mettre" -> 기기를 켜다 / 옷을
--            입다 / se mettre à...), plus pronunciation + 1-3 grammar
--            points per expression. Entirely separate from
--            expressions.detailed_analysis (added in 0013) -- that stays
--            untouched; this is an additive, independent feature.
-- =============================================================================

create table public.lemmas (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  lemma                text not null,
  part_of_speech       text,
  pronunciation_ipa    text,
  pronunciation_ko     text,
  pronunciation_note   text,
  grammar_notes        jsonb not null default '{}'::jsonb, -- {conjugation_present, past_participle, auxiliary, common_mistakes[]}
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (user_id, lemma)
);

create trigger trg_lemmas_updated_at
  before update on public.lemmas
  for each row execute function public.set_updated_at();

create table public.lemma_usages (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  lemma_id            uuid not null references public.lemmas(id) on delete cascade,
  label               text not null,
  meaning_en          text,
  pattern             text,
  sort_order          int not null default 0,
  -- Set true when the user edits the label by hand -- a later re-analysis
  -- must not silently rename it back.
  label_user_edited   boolean not null default false,
  created_at          timestamptz not null default now(),

  unique (lemma_id, label)
);

create index idx_lemma_usages_lemma_sort
  on public.lemma_usages (lemma_id, sort_order);

create table public.expression_analysis (
  expression_id        uuid primary key references public.expressions(id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  lemma_id             uuid references public.lemmas(id) on delete set null,
  usage_id             uuid references public.lemma_usages(id) on delete set null,
  -- Set true when the user manually moves this expression to a different
  -- usage -- re-analysis must then leave usage_id alone.
  usage_user_assigned  boolean not null default false,
  pronunciation_ko     text,
  pronunciation_liaison text,
  pronunciation_note   text,
  grammar_points       jsonb not null default '[]'::jsonb, -- [{form, meaning, example}]
  level                text check (level in ('A1', 'A2', 'B1', 'B2')),
  model                text,
  prompt_version       text,
  created_at           timestamptz not null default now()
);

create index idx_expression_analysis_lemma
  on public.expression_analysis (lemma_id);
create index idx_expression_analysis_usage
  on public.expression_analysis (usage_id);

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.lemmas enable row level security;
create policy "lemmas_select_own" on public.lemmas for select using (auth.uid() = user_id);
create policy "lemmas_insert_own" on public.lemmas for insert with check (auth.uid() = user_id);
create policy "lemmas_update_own" on public.lemmas for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.lemma_usages enable row level security;
create policy "lemma_usages_select_own" on public.lemma_usages for select using (auth.uid() = user_id);
create policy "lemma_usages_insert_own" on public.lemma_usages for insert with check (auth.uid() = user_id);
create policy "lemma_usages_update_own" on public.lemma_usages for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lemma_usages_delete_own" on public.lemma_usages for delete using (auth.uid() = user_id);

alter table public.expression_analysis enable row level security;
create policy "expression_analysis_select_own" on public.expression_analysis for select using (auth.uid() = user_id);
create policy "expression_analysis_insert_own" on public.expression_analysis for insert with check (auth.uid() = user_id);
create policy "expression_analysis_update_own" on public.expression_analysis for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
