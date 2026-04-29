// Admin endpoint: clean up email_blacklist rows tagged with source='dryrun:*' or 'allowlist:*'.
// See spec §11.5: "Production blacklist rows (source IS NULL) are never touched".
// GET returns counts (preview); POST deletes.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const supabase = createAdminClient();

  const [dryrunRes, allowlistRes] = await Promise.all([
    supabase.from('email_blacklist').select('email', { count: 'exact', head: true }).like('source', 'dryrun:%'),
    supabase.from('email_blacklist').select('email', { count: 'exact', head: true }).like('source', 'allowlist:%'),
  ]);

  return NextResponse.json({
    dryrun_count: dryrunRes.count ?? 0,
    allowlist_count: allowlistRes.count ?? 0,
  });
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const supabase = createAdminClient();

  // Two separate DELETEs — production rows (source IS NULL) cannot match either pattern
  const [dryrunDel, allowlistDel] = await Promise.all([
    supabase.from('email_blacklist').delete().like('source', 'dryrun:%').select('email'),
    supabase.from('email_blacklist').delete().like('source', 'allowlist:%').select('email'),
  ]);

  if (dryrunDel.error) return NextResponse.json({ error: dryrunDel.error.message }, { status: 500 });
  if (allowlistDel.error) return NextResponse.json({ error: allowlistDel.error.message }, { status: 500 });

  return NextResponse.json({
    deleted_dryrun: dryrunDel.data?.length ?? 0,
    deleted_allowlist: allowlistDel.data?.length ?? 0,
  });
}
