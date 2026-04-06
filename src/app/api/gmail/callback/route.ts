import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens, encryptToken } from '@/lib/gmail/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get('code');
  const state = searchParams.get('state'); // team_member_id passed via state param
  const error = searchParams.get('error');

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  if (error) {
    return NextResponse.redirect(`${appUrl}/settings?error=gmail_denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/settings?error=gmail_invalid`);
  }

  // Validate state matches cookie
  const cookieState = req.cookies.get('gmail_oauth_state')?.value;
  if (!cookieState || cookieState !== state) {
    return NextResponse.redirect(`${appUrl}/settings?error=gmail_state_mismatch`);
  }

  try {
    const tokens = await exchangeCodeForTokens(code);

    const encryptedAccess = encryptToken(tokens.access_token);
    const encryptedRefresh = tokens.refresh_token ? encryptToken(tokens.refresh_token) : null;

    const supabase = createAdminClient();
    const { error: dbErr } = await supabase
      .from('team_members')
      .update({
        gmail_connected: true,
        gmail_access_token: encryptedAccess,
        gmail_refresh_token: encryptedRefresh,
        gmail_token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        gmail_history_id: null,
        last_gmail_sync: null,
      })
      .eq('id', state);

    if (dbErr) {
      console.error('Gmail callback DB error:', dbErr.message);
      return NextResponse.redirect(`${appUrl}/settings?error=gmail_db_error`);
    }

    const response = NextResponse.redirect(`${appUrl}/settings?connected=true`);
    response.cookies.delete('gmail_oauth_state');
    return response;
  } catch (err) {
    console.error('Gmail callback error:', err);
    return NextResponse.redirect(`${appUrl}/settings?error=gmail_token_error`);
  }
}
