// Admin check for admin-only Edge Functions. The role comes from
// app_metadata of the user returned by auth.getUser(jwt) -- app_metadata
// can only be changed with the service role (SQL / dashboard), never by
// the user, unlike user_metadata. Pure so Vitest can test it.

export interface UserLike {
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
}

export function isAdminUser(user: UserLike | null | undefined): boolean {
  return user?.app_metadata?.role === 'admin';
}
