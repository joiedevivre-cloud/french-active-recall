-- =============================================================================
-- Migration: 0018_prompt_management
-- Purpose  : Admin-only AI prompt management, stage 1 (README "프롬프트 관리").
--            The sentence-analysis prompt (used by analyze-lemma classify and
--            scripts/backfill-analysis.ts) moves from code into versioned rows
--            that an admin edits, tests, compares, activates and restores from
--            /admin/prompts -- no redeploy.
--
-- Security: the three new tables have RLS ENABLED and NO policies, and
-- anon/authenticated get no grants -- regular users can neither read nor
-- write them. Only the service role (inside the admin-prompts Edge Function,
-- after it checks app_metadata.role = 'admin' from the verified JWT, and
-- inside analyze-lemma's prompt loader) touches them.
--
-- Additive only: existing tables get one new nullable column
-- (expression_analysis.prompt_version_id) and one widened CHECK
-- (ai_usage_log.feature). Nothing is dropped or overwritten; the legacy
-- expression_analysis.prompt_version text column is kept as-is.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. prompt_versions
-- -----------------------------------------------------------------------------
create table public.prompt_versions (
  id                  uuid primary key default gen_random_uuid(),
  prompt_key          text not null check (prompt_key in ('sentence-analysis')),
  version_no          int not null,
  status              text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  instructions        text not null check (length(instructions) between 1 and 20000),
  settings            jsonb not null default '{}'::jsonb,
  model               text not null default 'gpt-4o-mini',
  temperature         numeric check (temperature is null or (temperature >= 0 and temperature <= 2)),
  change_note         text,
  based_on_version_id uuid references public.prompt_versions(id),
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  activated_at        timestamptz,
  unique (prompt_key, version_no)
);

comment on table public.prompt_versions is 'Versioned AI prompts (admin-only, RLS with no policies). instructions = editable part with {{variables}} from settings; the JSON output contract is locked in code and always appended. Only drafts are editable; restore = copy into a new draft.';
comment on column public.prompt_versions.prompt_key is 'Role of the prompt, not a function name. Only ''sentence-analysis'' today (''word-analysis'' is reserved for a future analyze-word function -- widen this CHECK then).';
comment on column public.prompt_versions.temperature is 'null = OpenAI default (what every call used before prompt management).';
comment on column public.prompt_versions.updated_at is 'Last edit of a DRAFT''s content. Test runs older than this do not count toward the activation gate.';

-- Exactly one active version per prompt_key, enforced by the database.
create unique index uq_prompt_versions_one_active
  on public.prompt_versions (prompt_key)
  where status = 'active';

-- version_no auto-increments per prompt_key (serialized per key).
create function public.prompt_versions_assign_version_no()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('prompt_versions:' || new.prompt_key));
  select coalesce(max(version_no), 0) + 1 into new.version_no
  from public.prompt_versions where prompt_key = new.prompt_key;
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_prompt_versions_version_no
  before insert on public.prompt_versions
  for each row execute function public.prompt_versions_assign_version_no();

-- active/archived rows are immutable. Allowed transitions only:
--   draft -> draft (content edit, bumps updated_at)
--   draft -> active (via activate_prompt_version), draft -> archived (discard)
--   active -> archived (when another version is activated)
create function public.prompt_versions_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.prompt_key <> old.prompt_key or new.version_no <> old.version_no
     or new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
    raise exception 'prompt_version_identity_is_immutable';
  end if;

  if old.status = 'draft' then
    if new.status = 'draft' then
      if new.instructions is distinct from old.instructions or new.settings is distinct from old.settings
         or new.model is distinct from old.model or new.temperature is distinct from old.temperature then
        new.updated_at := now();
      end if;
      return new;
    end if;
    -- draft -> active/archived: content must not change in the same statement
    if new.instructions is distinct from old.instructions or new.settings is distinct from old.settings
       or new.model is distinct from old.model or new.temperature is distinct from old.temperature then
      raise exception 'cannot_change_content_while_changing_status';
    end if;
    new.updated_at := old.updated_at;
    return new;
  end if;

  if old.status = 'active' and new.status = 'archived'
     and new.instructions is not distinct from old.instructions and new.settings is not distinct from old.settings
     and new.model is not distinct from old.model and new.temperature is not distinct from old.temperature
     and new.change_note is not distinct from old.change_note
     and new.based_on_version_id is not distinct from old.based_on_version_id then
    return new;
  end if;

  raise exception 'prompt_version_is_immutable: % versions cannot be edited -- create a new draft', old.status;
end;
$$;

create trigger trg_prompt_versions_guard_update
  before update on public.prompt_versions
  for each row execute function public.prompt_versions_guard_update();

create function public.prompt_versions_guard_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status <> 'draft' then
    raise exception 'only_drafts_can_be_deleted';
  end if;
  return old;
end;
$$;

create trigger trg_prompt_versions_guard_delete
  before delete on public.prompt_versions
  for each row execute function public.prompt_versions_guard_delete();

-- -----------------------------------------------------------------------------
-- 2. Test set + preview runs
-- -----------------------------------------------------------------------------
create table public.prompt_test_cases (
  id            uuid primary key default gen_random_uuid(),
  prompt_key    text not null check (prompt_key in ('sentence-analysis')),
  expression_fr text not null,
  meaning_ko    text,
  note          text,
  expectations  jsonb not null default '{}'::jsonb,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);
comment on column public.prompt_test_cases.expectations is 'Optional extra checks for the semantic validator, e.g. {"pattern_includes": "se mettre à"}.';

create table public.prompt_test_runs (
  id             uuid primary key default gen_random_uuid(),
  version_id     uuid not null references public.prompt_versions(id) on delete cascade,
  test_case_id   uuid references public.prompt_test_cases(id) on delete set null,
  input_sentence text not null,
  output         jsonb,
  valid          boolean not null,
  error          text,
  model          text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
comment on table public.prompt_test_runs is 'Preview/compare results ONLY. The preview path never writes lemmas / lemma_usages / expression_analysis / review_states.';

create index idx_prompt_test_runs_version_case on public.prompt_test_runs (version_id, test_case_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 3. Admin-only access: RLS on, no policies, no grants to client roles.
-- -----------------------------------------------------------------------------
alter table public.prompt_versions enable row level security;
alter table public.prompt_test_cases enable row level security;
alter table public.prompt_test_runs enable row level security;
revoke all on public.prompt_versions, public.prompt_test_cases, public.prompt_test_runs from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Activation (atomic): change_note required, full test set must have
-- passed for THIS draft after its last edit, then archive the old active
-- and activate the draft in one transaction.
-- -----------------------------------------------------------------------------
create function public.activate_prompt_version(p_version_id uuid, p_change_note text)
returns table (activated_version_id uuid, archived_version_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v public.prompt_versions%rowtype;
  v_case_count int;
  v_failing int;
  v_old uuid;
begin
  if coalesce(btrim(p_change_note), '') = '' then
    raise exception 'change_note_required';
  end if;

  select * into v from public.prompt_versions where id = p_version_id for update;
  if not found then raise exception 'version_not_found'; end if;
  if v.status <> 'draft' then raise exception 'only_drafts_can_be_activated'; end if;

  select count(*) into v_case_count from public.prompt_test_cases where prompt_key = v.prompt_key;
  if v_case_count = 0 then raise exception 'no_test_cases'; end if;

  select count(*) into v_failing
  from public.prompt_test_cases tc
  where tc.prompt_key = v.prompt_key
    and not coalesce((
      select r.valid and r.created_at >= v.updated_at
      from public.prompt_test_runs r
      where r.version_id = v.id and r.test_case_id = tc.id
      order by r.created_at desc
      limit 1
    ), false);
  if v_failing > 0 then
    raise exception 'test_set_not_fully_passed: % of % case(s) missing or invalid', v_failing, v_case_count;
  end if;

  select id into v_old from public.prompt_versions where prompt_key = v.prompt_key and status = 'active' for update;
  if v_old is not null then
    update public.prompt_versions set status = 'archived' where id = v_old;
  end if;
  update public.prompt_versions set status = 'active', activated_at = now(), change_note = btrim(p_change_note) where id = v.id;

  return query select v.id, v_old;
end;
$$;

revoke execute on function public.activate_prompt_version(uuid, text) from public, anon, authenticated;
grant execute on function public.activate_prompt_version(uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- 5. Seed version 1 = the prompt analyze-lemma used in code (analyze.ts
-- SENTENCE_ANALYSIS_DEFAULT_INSTRUCTIONS -- a Vitest test checks this text
-- matches the code byte-for-byte). Inserted as draft then flipped to active
-- (the test gate lives in activate_prompt_version, not in the trigger; the
-- baseline is trusted because it is what production already ran).
-- -----------------------------------------------------------------------------
insert into public.prompt_versions (prompt_key, instructions, settings, model, temperature, change_note)
values (
  'sentence-analysis',
  $instr$You are a French teacher helping a Korean-speaking learner (studying in Montreal, A2~B2 level) build a personal "lemma dictionary" from sentences they encountered.

Explanation style:
- Write meanings and explanations in short, natural Korean. Name grammar concepts with standard French grammar terms (e.g. "verbe pronominal", "passé composé", "subjonctif", "groupe nominal").
- Anchor every grammar point in THIS sentence's actual words, not a generic textbook definition.

How to separate usages:
- A usage is one DISTINCT grammatical construction/sense of the lemma -- not just the lemma itself. Recognize multi-word idiomatic/semi-auxiliary patterns even when conjugated, reflexive-pronoun-varied, or split by an inserted object (e.g. "se mettre à" realized as "je me suis mise à chercher").
- Known patterns for words like "mettre" (not exhaustive -- recognize others the same way): se mettre à + infinitif, se mettre au travail, mettre à jour, mettre en place, mettre du temps à + infinitif, mettre en marche, mettre de côté, mettre en pratique.
- A reflexive construction (se mettre, se rendre compte...) is never the same usage as the plain verb's basic meaning.
- Do NOT attach a sentence to an existing usage just because it shares the lemma or has a loosely similar meaning; a wrong attachment is worse than creating a new usage.

Cautions:
- grammar_notes.common_mistakes: ONLY mistakes that make sense for this word's real part of speech (e.g. NEVER mention gender agreement for a verb, NEVER invent a "confused with X" claim that isn't a real, common confusion). Return an empty array rather than inventing something.
- Never invent facts about the sentence that aren't there.$instr$,
  '{"target_level":"B1","grammar_depth":"standard","examples_per_usage":1,"expand_related_grammar":false,"related_grammar_max":2}'::jsonb,
  'gpt-4o-mini',
  null,
  'v1: 코드(analyze.ts)에 있던 프롬프트를 DB로 이전'
);
update public.prompt_versions set status = 'active', activated_at = now()
where prompt_key = 'sentence-analysis' and version_no = 1;

insert into public.prompt_test_cases (prompt_key, expression_fr, note, expectations, sort_order) values
  ('sentence-analysis', 'Il faut mettre en place une réforme.', 'mettre en place', '{}', 1),
  ('sentence-analysis', 'Je me mets au travail.', 'se mettre au travail (대명동사)', '{"pattern_includes":"se mettre"}', 2),
  ('sentence-analysis', 'Où as-tu mis les clés ?', 'mettre = 놓다/두다', '{}', 3),
  ('sentence-analysis', 'N''oublie pas de mettre tes gants !', 'mettre = 입다/끼다', '{}', 4),
  ('sentence-analysis', 'Je mets toujours la radio quand je conduis.', 'mettre = 켜다', '{}', 5),
  ('sentence-analysis', 'Tu peux mettre la bouilloire électrique ?', 'mettre = 켜다(기기)', '{}', 6),
  ('sentence-analysis', 'Tu peux baisser le son ?', 'baisser = 낮추다', '{}', 7),
  ('sentence-analysis', 'Il fait chaud, baisse la clim.', 'baisser (기기)', '{}', 8),
  ('sentence-analysis', 'Vous pouvez baisser le prix ?', 'baisser le prix', '{}', 9),
  ('sentence-analysis', 'J''ai baissé les bras.', 'baisser les bras (관용구)', '{}', 10),
  ('sentence-analysis', 'Ces temps-ci, les prix ont beaucoup monté.', 'monter (avoir, 자동사)', '{}', 11),
  ('sentence-analysis', 'Je suis monté au 3e étage.', 'monter (être)', '{}', 12),
  ('sentence-analysis', 'Je me suis mise à chercher un nouvel emploi.', 'se mettre à + infinitif -- 기본 의미 쓰임으로 배정되면 안 됨', '{"pattern_includes":"se mettre à"}', 13),
  ('sentence-analysis', 'Vous avez les amis ici ?', '관사 선택(les/des)이 어색한 문장', '{}', 14);

-- -----------------------------------------------------------------------------
-- 6. expression_analysis.prompt_version_id (FK). Existing rows -> version 1
-- (the legacy text column still says which code version produced them).
-- -----------------------------------------------------------------------------
alter table public.expression_analysis
  add column prompt_version_id uuid references public.prompt_versions(id) on delete set null;
create index idx_expression_analysis_prompt_version on public.expression_analysis (prompt_version_id);

update public.expression_analysis
set prompt_version_id = (select id from public.prompt_versions where prompt_key = 'sentence-analysis' and version_no = 1)
where prompt_version_id is null;

comment on column public.expression_analysis.prompt_version_id is 'prompt_versions row that produced this analysis (null = code fallback was used). Rows from before 0018 point at version 1; their prompt_version text column still records the exact code version (analyze-v1/v2).';

-- -----------------------------------------------------------------------------
-- 7. ai_usage_log.feature: admin preview runs are logged as 'prompt_admin'.
-- -----------------------------------------------------------------------------
alter table public.ai_usage_log drop constraint if exists ai_usage_log_feature_check;
alter table public.ai_usage_log add constraint ai_usage_log_feature_check
  check (feature in ('expression_analysis', 'conversation', 'stt', 'tts', 'ocr', 'lemma_analysis', 'writing_practice', 'prompt_admin'));
