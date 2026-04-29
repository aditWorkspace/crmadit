import { google } from 'googleapis';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptToken, encryptToken, refreshAccessToken } from './auth';

export interface GmailClientResult {
  gmail: ReturnType<typeof google.gmail>;
  accessToken: string;
}

// Narrower interface used by the cold-outreach send pipeline.
// The real client returned by getGmailClientForMember() implements this
// implicitly via duck typing; the MockGmailClient implements it explicitly.
// Captures only the surface PR 3's send path actually uses.
export interface CampaignGmailClient {
  users: {
    messages: {
      send: (params: {
        userId: string;
        requestBody: { raw: string };
      }) => Promise<{ data: { id?: string | null; threadId?: string | null } }>;
    };
  };
}

// Simple in-memory lock to prevent concurrent token refresh for the same member
const refreshLocks = new Map<string, Promise<string>>();

async function getAccessToken(teamMemberId: string, member: {
  gmail_access_token: string;
  gmail_refresh_token: string;
  gmail_token_expiry: string | null;
}): Promise<string> {
  const expiry = member.gmail_token_expiry ? new Date(member.gmail_token_expiry).getTime() : 0;
  const isExpired = Date.now() >= expiry - 60_000; // refresh 1 min early

  if (!isExpired) {
    return decryptToken(member.gmail_access_token);
  }

  // Check for an in-flight refresh for this member — prevents race condition
  const existing = refreshLocks.get(teamMemberId);
  if (existing) return existing;

  const refreshPromise = (async () => {
    try {
      const supabase = createAdminClient();
      const refreshed = await refreshAccessToken(member.gmail_refresh_token);

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

      return refreshed.access_token;
    } finally {
      refreshLocks.delete(teamMemberId);
    }
  })();

  refreshLocks.set(teamMemberId, refreshPromise);
  return refreshPromise;
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

  const accessToken = await getAccessToken(teamMemberId, member);

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({ access_token: accessToken });

  const gmail = google.gmail({ version: 'v1', auth });
  return { gmail, accessToken };
}

/**
 * Returns a narrowed CampaignGmailClient view of the per-member Gmail
 * client. The real client structurally satisfies the interface; this
 * adapter just makes the assignment explicit so consumers don't need
 * `as unknown as CampaignGmailClient`. Used by the cold-outreach send
 * pipeline (PR 3).
 */
export async function getCampaignGmailClient(
  teamMemberId: string,
): Promise<CampaignGmailClient> {
  const { gmail } = await getGmailClientForMember(teamMemberId);
  // The real google.gmail() client has all the methods CampaignGmailClient
  // declares (users.messages.send with the same param/return shape) — TS
  // just can't prove that structurally without help from the consumer.
  // The cast here is the ONE place we acknowledge the structural match;
  // every other caller now imports this typed wrapper.
  return gmail as unknown as CampaignGmailClient;
}
