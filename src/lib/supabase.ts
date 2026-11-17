import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!supabaseUrl || !supabaseKey) {
  // Fail loudly in dev/build rather than silently falling back to a dead
  // client -- a misconfigured env var should never look like "it works but
  // nothing saves".
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env.local and fill in the Supabase project values.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    // PKCE is required for the OAuth redirect to come back as a `?code=`
    // query param instead of a `#access_token=` URL fragment -- the latter
    // would collide with react-router's BrowserRouter history.
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
