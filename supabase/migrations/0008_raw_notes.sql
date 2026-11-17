-- =============================================================================
-- Migration: 0008_raw_notes
-- Purpose  : Preserve the full pasted text from "붙여넣기 저장" verbatim,
--            before any parsing, and link expressions back to it.
-- =============================================================================

create table public.raw_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  client_id  uuid, -- offline idempotent upsert, same pattern as expressions.client_id
  content    text not null,
  source_type text not null default 'import',
  created_at timestamptz not null default now()
);

create unique index uq_raw_notes_user_client_id
  on public.raw_notes (user_id, client_id)
  where client_id is not null;

create index idx_raw_notes_user_created_at
  on public.raw_notes (user_id, created_at desc);

alter table public.raw_notes enable row level security;

create policy "raw_notes_select_own"
  on public.raw_notes for select
  using (auth.uid() = user_id);

create policy "raw_notes_insert_own"
  on public.raw_notes for insert
  with check (auth.uid() = user_id);

-- Append-only by design: no update/delete policy for raw_notes.

alter table public.expressions
  add column raw_note_id uuid references public.raw_notes(id) on delete set null;

create index idx_expressions_raw_note_id
  on public.expressions (raw_note_id)
  where raw_note_id is not null;
