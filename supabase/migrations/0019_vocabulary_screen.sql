-- =============================================================================
-- Migration: 0019_vocabulary_screen
-- Purpose  : 단어장 screen, stage 1 (README "단어장").
--   - lemmas.forms        : conjugated / inflected forms for search
--                            ("mise" finds mettre). Empty until the stage-2
--                            word analysis (analyze-word) fills it.
--   - lemmas.is_favorite  : 즐겨찾기
--   - lemmas.word_analysis_*: status of the (stage-2) word analysis, so the
--                            list can show 분석 대기 / 실패 honestly now.
--                            Every existing lemma starts as 'pending' --
--                            no word analysis has ever run.
--
-- SAFE TO RE-RUN: every statement uses IF NOT EXISTS / guards. Purely
-- additive -- no existing column, row or policy is changed or dropped.
-- RLS: lemmas policies from 0014 (user_id = auth.uid()) cover the new
-- columns automatically.
-- =============================================================================

alter table public.lemmas add column if not exists forms text[] not null default '{}';
alter table public.lemmas add column if not exists is_favorite boolean not null default false;
alter table public.lemmas add column if not exists word_analysis_status text not null default 'pending';
alter table public.lemmas add column if not exists word_analysis_started_at timestamptz;
alter table public.lemmas add column if not exists word_analyzed_at timestamptz;
alter table public.lemmas add column if not exists word_analysis_error text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lemmas_word_analysis_status_check') then
    alter table public.lemmas add constraint lemmas_word_analysis_status_check
      check (word_analysis_status in ('pending', 'processing', 'done', 'failed'));
  end if;
end;
$$;

create index if not exists idx_lemmas_user_favorite on public.lemmas (user_id) where is_favorite;

comment on column public.lemmas.forms is 'Inflected/conjugated forms a learner might type into search (mise, mis, mets, me suis mise...). Filled by the word analysis (analyze-word, stage 2); empty until then.';
comment on column public.lemmas.word_analysis_status is 'pending = no word analysis yet / processing (started_at set; > 5 min counts as failed) / done / failed (word_analysis_error says why). Sentence analysis (expression_analysis) is separate.';
