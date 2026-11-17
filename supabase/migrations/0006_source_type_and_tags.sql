-- =============================================================================
-- Migration: 0006_source_type_and_tags
-- Purpose  : Support the ChatGPT "paste import" feature (and the matching
--            one-off CSV backfill script): adds expressions.tags (분류) and
--            expressions.source_label (출처, verbatim), and widens the
--            source_type enum to the values the UI filters on.
--
-- source_type rename/consolidation (no real data exists yet beyond manual
-- testing, so this is a safe rename rather than a dual-value migration):
--   'class'             -> 'school'   (수업 모드/학교에서 배운 표현)
--   'daily_conversation'-> 'daily'    (일상 회화)
--   'import_csv'        -> 'import'   (generic CSV/paste import fallback)
--   new values added: 'news', 'video'
--   unchanged: 'manual', 'tv5monde', 'ocr', 'voice', 'import_anki', 'b2_700'
-- =============================================================================

alter table public.expressions
  add column tags text[] not null default '{}',
  add column source_label text;

comment on column public.expressions.tags is '분류 (free-text category/grouping tags from CSV import or manual entry, e.g. a lemma cluster or topic like "과학").';
comment on column public.expressions.source_label is '출처, stored verbatim from the CSV/paste import (e.g. "기존 복습 CSV"). Distinct from source_type, which is the constrained enum used for filtering.';

-- Rename any rows using the old values before tightening the constraint.
update public.expressions set source_type = 'school' where source_type = 'class';
update public.expressions set source_type = 'daily' where source_type = 'daily_conversation';
update public.expressions set source_type = 'import' where source_type = 'import_csv';

alter table public.expressions drop constraint expressions_source_type_check;
alter table public.expressions add constraint expressions_source_type_check check (source_type in (
  'manual', 'school', 'tv5monde', 'daily', 'news', 'video',
  'ocr', 'voice', 'import', 'import_anki', 'b2_700'
));
