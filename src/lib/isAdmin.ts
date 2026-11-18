import type { Session } from '@supabase/supabase-js';
import { isAdminUser } from '../../supabase/functions/_shared/adminAuth';

/**
 * UI convenience only (show/hide the admin menu). The real check happens in
 * the admin-prompts Edge Function on the verified JWT. app_metadata.role is
 * set by SQL (README "관리자 권한 설정") and only reaches the client after
 * the next sign-in / token refresh.
 */
export function isAdminSession(session: Session | null | undefined): boolean {
  return isAdminUser(session?.user ?? null);
}
