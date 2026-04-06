import { NextRequest, NextResponse } from 'next/server';
import { buildAuthUrl } from '@/lib/gmail/auth';
import { createAdminClient } from '@/lib/supabase/admin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  // Browser redirect — no x-team-member-id header. Read from query param instead.
  const memberId = req.nextUrl.searchParams.get('member_id');

  if (!memberId || !UUID_RE.test(memberId)) {
    return NextResponse.json({ error: 'Missing or invalid member_id' }, { status: 400 });
  }

  // Verify the member exists
  const supabase = createAdminClient();
  const { data: member } = await supabase
    .from('team_members')
    .select('id')
    .eq('id', memberId)
    .single();

  if (!member) {
    return NextResponse.json({ error: 'Team member not found' }, { status: 404 });
  }

  const authUrl = buildAuthUrl(memberId);

  const response = NextResponse.redirect(authUrl);
  // Store team_member_id in a short-lived cookie so callback can verify state
  response.cookies.set('gmail_oauth_state', memberId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600, // 10 minutes
    path: '/',
    sameSite: 'lax',
  });

  return response;
}
