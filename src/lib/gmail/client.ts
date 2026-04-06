import { google } from 'googleapis';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptToken, encryptToken, refreshAccessToken } from './auth';

export interface GmailClientResult {
  gmail: ReturnType<typeof google.gmail>;
  accessToken: string;
}

export async function getGmailClientForMember(teamMemberId: string): Promise<GmailClientResult> {
  const supabase = createAdminClient();

  const { data: member, error } = await supabase
    .from('team_members')
    .select('id, gmail_access_token, gmail_refresh_token, gmail_token_expiry, gmail_connected')
    .eq('id', teamMemberId)
    .single();

  if (error || !member) throw new Error(`Team member not found: ${teamMemberId}`);
  if (!member.gmail_connected) throw new Error(`Gmail not connected for member: ${teamMemberId}`);
  if (!member.gmail_access_token || !member.gmail_refresh_token) {
    throw new Error(`Gmail tokens missing for member: ${teamMemberId}`);
  }

  let accessToken: string;
  const expiry = member.gmail_token_expiry ? new Date(member.gmail_token_expiry).getTime() : 0;
  const isExpired = Date.now() >= expiry - 60_000; // refresh 1 min early

  if (isExpired) {
    const refreshed = await refreshAccessToken(member.gmail_refresh_token);
    accessToken = refreshed.access_token;

    // Update stored access token, refresh token (rotation), and expiry
    const encryptedAccess = encryptToken(refreshed.access_token);
    const encryptedRefresh = encryptToken(refreshed.refresh_token ?? '');
    await supabase
      .from('team_members')
      .update({
        gmail_access_token: encryptedAccess,
        gmail_refresh_token: encryptedRefresh,
        gmail_token_expiry: refreshed.expiry_date
          ? new Date(refreshed.expiry_date).toISOString()
          : null,
      })
      .eq('id', teamMemberId);
  } else {
    accessToken = decryptToken(member.gmail_access_token);
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({ access_token: accessToken });

  const gmail = google.gmail({ version: 'v1', auth });
  return { gmail, accessToken };
}
