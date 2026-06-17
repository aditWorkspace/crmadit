import 'server-only'; // hard guard: this module (and the service key) never bundles client-side
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// SERVICE-ROLE client, used ONLY in server components. landing_pages holds
// recipient PII and has RLS enabled with no public policy, so the anon key
// can't read it. We render server-side and select only non-PII columns. The
// key is a server-only env (NOT NEXT_PUBLIC_), so it never reaches the browser.
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}
