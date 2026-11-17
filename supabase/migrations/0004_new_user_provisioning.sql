-- =============================================================================
-- Migration: 0004_new_user_provisioning
-- Purpose  : Auto-create default rows for a brand-new auth.users row.
--
-- Why this matters for Google OAuth specifically: with email/password there
-- is an explicit "sign up" step where the app controls what happens first.
-- With Google (and any OAuth provider), the *first successful login* IS the
-- account creation -- Supabase inserts into auth.users itself, with no app
-- code in between. If user_settings/user_streaks/ai_rate_limits are only
-- created lazily from the frontend, a user who closes the tab right after
-- the Google redirect can end up with an auth.users row but no settings row,
-- and later queries that assume a settings row exists will fail. A DB
-- trigger on auth.users removes that race entirely.
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.user_streaks (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.ai_rate_limits (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user is 'Runs once per new auth.users row (any provider, including Google OAuth) and seeds the default per-user rows this app relies on existing. security definer is required because the trigger fires as the user inserting into auth.users, not as a role with insert rights on these tables.';

-- auth.users is in the auth schema, owned by Supabase -- creating a trigger
-- on it is the standard, documented Supabase pattern for this.
drop trigger if exists trg_on_auth_user_created on auth.users;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
