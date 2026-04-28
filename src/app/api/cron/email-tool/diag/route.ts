// One-off PR 4 diagnostic per the verification checklist (test 1).
// Returns presence flags for all four required env vars / connection
// signals. Never returns values.
//
// REMOVE before PR 4 is closed out — this is a troubleshooter, not part
// of the long-term API surface.
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const clientId = !!process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = !!process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = !!process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  // postgresUrl: probe by hitting the admin client. If this throws, the
  // Postgres connection is broken; otherwise it's reachable.
  let postgresUrl = false;
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from('email_pool_state').select('id').eq('id', 1).single();
    postgresUrl = !error;
  } catch {
    postgresUrl = false;
  }

  return NextResponse.json({ clientId, clientSecret, refreshToken, postgresUrl });
}
