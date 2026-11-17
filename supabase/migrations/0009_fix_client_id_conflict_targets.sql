-- =============================================================================
-- Migration: 0009_fix_client_id_conflict_targets
-- Purpose  : Fix "there is no unique or exclusion constraint matching the
--            ON CONFLICT specification" on expressions/raw_notes upserts.
--
-- Root cause: 0001/0008 created PARTIAL unique indexes
--   (user_id, client_id) WHERE client_id IS NOT NULL
-- but every upsert in the app (src/features/capture/addExpression.ts,
-- src/features/paste-save/pasteSave.ts) targets the unconditional
-- ON CONFLICT (user_id, client_id). Postgres will not match a plain
-- ON CONFLICT target against a partial index, so every single upsert has
-- been failing since the first deploy -- nothing ever reached the server.
--
-- The app always generates a client_id for every row it saves, so making
-- the column NOT NULL (with a default, for safety) and using a normal,
-- non-partial UNIQUE constraint matches how it's actually used and fixes
-- the ON CONFLICT mismatch.
-- =============================================================================

-- Defensive cleanup first (expected to be a no-op -- no upsert against the
-- broken index has ever succeeded, so there should be no real rows to fix
-- here -- but this makes the migration safe to run regardless of that).
update public.expressions set client_id = gen_random_uuid() where client_id is null;
update public.raw_notes set client_id = gen_random_uuid() where client_id is null;

-- If two rows for the same user somehow ended up with the same client_id
-- (e.g. a retried request that partially got through before this fix),
-- keep the oldest one's client_id and regenerate the rest, so the new
-- UNIQUE constraint below can be added without failing on existing data.
with dupes as (
  select id, row_number() over (partition by user_id, client_id order by created_at) as rn
  from public.expressions
)
update public.expressions e
set client_id = gen_random_uuid()
from dupes
where e.id = dupes.id and dupes.rn > 1;

with dupes as (
  select id, row_number() over (partition by user_id, client_id order by created_at) as rn
  from public.raw_notes
)
update public.raw_notes r
set client_id = gen_random_uuid()
from dupes
where r.id = dupes.id and dupes.rn > 1;

alter table public.expressions
  alter column client_id set default gen_random_uuid(),
  alter column client_id set not null;

alter table public.raw_notes
  alter column client_id set default gen_random_uuid(),
  alter column client_id set not null;

drop index if exists public.uq_expressions_user_client_id;
alter table public.expressions
  add constraint uq_expressions_user_client_id unique (user_id, client_id);

drop index if exists public.uq_raw_notes_user_client_id;
alter table public.raw_notes
  add constraint uq_raw_notes_user_client_id unique (user_id, client_id);

comment on column public.expressions.client_id is 'Client-generated UUID, always set (see the app''s upsert calls), used as the ON CONFLICT target for idempotent offline-sync retries. Unique per user, not globally -- two different users can coincidentally share a client_id with no conflict.';
comment on column public.raw_notes.client_id is 'Same idempotent-upsert pattern as expressions.client_id.';
