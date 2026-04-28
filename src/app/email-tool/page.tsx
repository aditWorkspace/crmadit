// Server component for /email-tool. Gates on session, hydrates the
// client with cooldown / fresh-remaining / history / blacklist-size
// (admin only). Mirrors the standalone repo's app/dashboard/page.tsx
// data-fetch contract so the client behaviour ports cleanly.
//
// Cold-cache recompute parity: if email_pool_state.eff_remaining_seq
// doesn't match next_sequence (cache stale or never written), call the
// RPC and write the fresh value back so subsequent loads hit the cache.

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/auth/cookie-session';
import { createAdminClient } from '@/lib/supabase/admin';
import { HISTORY_CAP } from '@/lib/email-tool/constants';
import EmailToolClient from './client';

export const dynamic = 'force-dynamic';

interface HistoryEntry {
  id: string;
  url: string;
  title: string | null;
  created_at: string;
  created_by?: string;          // populated only for admin (all-users) view
}

interface DashboardProps {
  name: string;
  cooldownIso: string | null;
  remaining: number;
  history: HistoryEntry[];
  isAdmin: boolean;
  blacklistSize: number;
}

export default async function EmailToolPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const payload = verifySession(token);
  if (!payload) redirect('/');

  const supabase = createAdminClient();
  const { data: member } = await supabase
    .from('team_members')
    .select('id, name, email, is_admin, email_batch_next_at')
    .eq('id', payload.tm)
    .single();
  if (!member) redirect('/');

  const isAdmin = member.is_admin === true;

  // Pool state + cold-cache recompute.
  const { data: state } = await supabase
    .from('email_pool_state')
    .select('next_sequence, eff_remaining_seq, eff_remaining_fresh')
    .eq('id', 1)
    .single();

  let remaining: number;
  if (state && state.eff_remaining_seq === state.next_sequence && state.eff_remaining_fresh != null) {
    remaining = state.eff_remaining_fresh;
  } else {
    const { data: fresh } = await supabase.rpc('email_tool_fresh_remaining');
    remaining = (fresh ?? 0) as number;
    await supabase
      .from('email_pool_state')
      .update({
        eff_remaining_seq: state?.next_sequence ?? 0,
        eff_remaining_fresh: remaining,
        eff_updated_at: new Date().toISOString(),
      })
      .eq('id', 1);
  }

  // History — admin sees all-users with author labels; non-admin sees own.
  let history: HistoryEntry[] = [];
  if (isAdmin) {
    const { data } = await supabase
      .from('email_batch_history')
      .select('id, sheet_url, sheet_title, created_at, team_members(name)')
      .order('created_at', { ascending: false })
      .limit(HISTORY_CAP);
    history = (data ?? []).map(h => ({
      id: h.id,
      url: h.sheet_url,
      title: h.sheet_title,
      created_at: h.created_at,
      created_by: (h.team_members as unknown as { name?: string } | null)?.name,
    }));
  } else {
    const { data } = await supabase
      .from('email_batch_history')
      .select('id, sheet_url, sheet_title, created_at')
      .eq('team_member_id', member.id)
      .order('created_at', { ascending: false })
      .limit(HISTORY_CAP);
    history = (data ?? []).map(h => ({
      id: h.id,
      url: h.sheet_url,
      title: h.sheet_title,
      created_at: h.created_at,
    }));
  }

  // Blacklist size — admin only.
  let blacklistSize = 0;
  if (isAdmin) {
    const { count } = await supabase
      .from('email_blacklist')
      .select('*', { count: 'exact', head: true });
    blacklistSize = count ?? 0;
  }

  const props: DashboardProps = {
    name: member.name,
    cooldownIso: member.email_batch_next_at ?? null,
    remaining,
    history,
    isAdmin,
    blacklistSize,
  };

  return <EmailToolClient {...props} />;
}
