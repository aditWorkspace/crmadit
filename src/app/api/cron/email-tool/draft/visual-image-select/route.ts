// POST — apply a chosen image to a draft: sets it as THE image for both the
// email (re-renders email_html) and the landing page (updates landing_pages),
// so the same image is used everywhere and the calproduct.com page updates
// automatically. Admin-only.
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { composeEmail } from '@/lib/ai/visual-draft';

export const runtime = 'nodejs';

async function authorized(req: NextRequest): Promise<boolean> {
  if (req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`) return true;
  const session = await getSessionFromRequest(req);
  return !!session?.is_admin;
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const id = body?.id as string | undefined;
  const imageUrl = body?.image_url as string | undefined;
  if (!id || !imageUrl) return NextResponse.json({ error: 'id and image_url required' }, { status: 400 });

  // Only allow images from our own public Storage bucket (no arbitrary URLs in
  // the email/page).
  const prefix = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '') + '/storage/v1/object/public/outreach-images/';
  if (!imageUrl.startsWith(prefix)) return NextResponse.json({ error: 'image_url must be an outreach-images URL' }, { status: 400 });

  const supabase = createAdminClient();
  const { data: draft } = await supabase
    .from('cold_email_drafts')
    .select('id, first_name, sender_name, industry, page_slug')
    .eq('id', id)
    .maybeSingle();
  if (!draft) return NextResponse.json({ error: 'draft not found' }, { status: 404 });
  const d = draft as { first_name: string | null; sender_name: string; industry: string | null; page_slug: string | null };

  const first = (d.first_name ?? '').trim() || 'there';
  const { emailHtml } = composeEmail({ first, senderName: d.sender_name, industry: d.industry ?? '', pageSlug: d.page_slug ?? '', imageUrl });

  await supabase.from('cold_email_drafts').update({ image_url: imageUrl, email_html: emailHtml }).eq('id', id);
  if (d.page_slug) {
    await supabase.from('landing_pages').update({ image_url: imageUrl, updated_at: new Date().toISOString() }).eq('slug', d.page_slug);
  }
  return NextResponse.json({ ok: true, image_url: imageUrl, email_html: emailHtml });
}
