// POST — dashboard actions on a visual draft: skip | regenerate | set-sender |
// edit. Admin-only. Path under /api/cron/* per the deployment-protection
// convention. (The actual SEND is a separate route, visual-send.)
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { composeEmail, renderEmailHtml, pageUrlForSlug } from '@/lib/ai/visual-draft';

export const runtime = 'nodejs';

async function authorized(req: NextRequest): Promise<boolean> {
  if (req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`) return true;
  const session = await getSessionFromRequest(req);
  return !!session?.is_admin;
}

interface DraftRow {
  id: string; first_name: string | null; page_slug: string | null;
  image_url: string | null; subject: string | null; industry: string | null;
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const id = body?.id as string | undefined;
  const action = body?.action as string | undefined;
  if (!id || !action) return NextResponse.json({ error: 'id and action required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data: draft } = await supabase
    .from('cold_email_drafts')
    .select('id, first_name, page_slug, image_url, subject, industry')
    .eq('id', id)
    .maybeSingle();
  if (!draft) return NextResponse.json({ error: 'draft not found' }, { status: 404 });
  const d = draft as DraftRow;

  if (action === 'skip') {
    await supabase.from('cold_email_drafts').update({ status: 'skipped', skip_reason: 'dashboard_skip' }).eq('id', id);
    return NextResponse.json({ ok: true, status: 'skipped' });
  }

  if (action === 'regenerate') {
    // Back to the queue → the worker re-runs the full visual pipeline (new
    // image + page) on the next tick.
    await supabase.from('cold_email_drafts')
      .update({ status: 'queued', attempt_count: 0, retry_at: null, error: null, worker_locked_until: null })
      .eq('id', id);
    return NextResponse.json({ ok: true, status: 'queued' });
  }

  if (action === 'set-sender') {
    const senderId = body?.sender_account_id as string | undefined;
    if (!senderId) return NextResponse.json({ error: 'sender_account_id required' }, { status: 400 });
    const { data: sender } = await supabase.from('team_members').select('id, name, email').eq('id', senderId).maybeSingle();
    if (!sender) return NextResponse.json({ error: 'sender not found' }, { status: 400 });
    const s = sender as { id: string; name: string; email: string };
    const first = (d.first_name || '').trim() || 'there';
    const { subject, body: emailBody, emailHtml } = composeEmail({ first, senderName: s.name, industry: d.industry ?? '', pageSlug: d.page_slug ?? '', imageUrl: d.image_url });
    await supabase.from('cold_email_drafts').update({
      sender_account_id: s.id, sender_name: s.name, sender_email: s.email,
      subject, body: emailBody, email_html: emailHtml,
    }).eq('id', id);
    if (d.page_slug) await supabase.from('landing_pages').update({ sender_name: s.name }).eq('slug', d.page_slug);
    return NextResponse.json({ ok: true, subject, body: emailBody, email_html: emailHtml });
  }

  if (action === 'edit') {
    // Free-form edit of the email body (and optional subject). Re-render the
    // HTML from the edited text + the existing image/page link.
    const newBody = String(body?.body ?? '').slice(0, 4000);
    const newSubject = body?.subject != null ? String(body.subject).slice(0, 200) : (d.subject ?? '');
    const pageUrl = d.page_slug ? pageUrlForSlug(d.page_slug) : null;
    const emailHtml = renderEmailHtml(newBody, d.image_url, pageUrl);
    await supabase.from('cold_email_drafts').update({ subject: newSubject, body: newBody, email_html: emailHtml }).eq('id', id);
    return NextResponse.json({ ok: true, email_html: emailHtml });
  }

  return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
}
