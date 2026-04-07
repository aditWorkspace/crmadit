import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { runInitialSync } from '@/lib/gmail/sync';

/**
 * POST /api/leads/resync
 *
 * Triggers a full initial sync for ALL connected founders.
 * Resets their gmail_history_id so runInitialSync does a fresh search.
 * Use this to re-import the last 14 days of emails for all founders.
 */
export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();
  const { data: members } = await supabase
    .from('team_members')
    .select('id, name, gmail_connected')
    .eq('gmail_connected', true);

  if (!members?.length) {
    return NextResponse.json({ error: 'No connected members' }, { status: 400 });
  }

  const results: Array<{ name: string; synced: number; created: number; errors: string[] }> = [];

  for (const m of members) {
    // Reset history ID so runInitialSync does a full search
    await supabase
      .from('team_members')
      .update({ gmail_history_id: null })
      .eq('id', m.id);

    try {
      const r = await runInitialSync(m.id);
      results.push({
        name: m.name,
        synced: r.synced,
        created: r.created_leads,
        errors: r.errors.slice(0, 5), // cap error list
      });
    } catch (err) {
      results.push({
        name: m.name,
        synced: 0,
        created: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  return NextResponse.json({ success: true, results });
}
