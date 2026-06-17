// POST — one-off backfill for already-generated ready drafts: re-render
// email_html with the new Gmail-default font (Arial 14px) + compress the
// (huge PNG) image to a fast JPEG, applied to both the email and the landing
// page. Processes a batch per call; call repeatedly until remaining=0.
// CRON_SECRET or admin.
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { composeEmail, compressImage } from '@/lib/ai/visual-draft';

export const runtime = 'nodejs';
export const maxDuration = 300;

const BUCKET = 'outreach-images';
const BATCH = 20;

async function authorized(req: NextRequest): Promise<boolean> {
  if (req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`) return true;
  const session = await getSessionFromRequest(req);
  return !!session?.is_admin;
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const supabase = createAdminClient();

  const { data } = await supabase
    .from('cold_email_drafts')
    .select('id, first_name, sender_name, industry, page_slug, image_url')
    .eq('status', 'ready')
    .not('email_html', 'like', '%font-family:Arial%')
    .limit(BATCH);
  const drafts = (data ?? []) as Array<{ id: string; first_name: string | null; sender_name: string; industry: string | null; page_slug: string | null; image_url: string | null }>;

  let processed = 0, failed = 0;
  for (const d of drafts) {
    try {
      let url = d.image_url;
      // compress the old PNG to a fast JPEG (if not already a .jpg)
      if (url && !/\.jpe?g(\?|$)/i.test(url) && d.page_slug) {
        const res = await fetch(url);
        if (res.ok) {
          const jpg = await compressImage(Buffer.from(await res.arrayBuffer()));
          const key = `${d.page_slug}.jpg`;
          const { error } = await supabase.storage.from(BUCKET).upload(key, jpg, { contentType: 'image/jpeg', upsert: true });
          if (!error) url = supabase.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
        }
      }
      const { emailHtml } = composeEmail({
        first: (d.first_name ?? '').trim() || 'there',
        senderName: d.sender_name, industry: d.industry ?? '', pageSlug: d.page_slug ?? '', imageUrl: url,
      });
      await supabase.from('cold_email_drafts').update({ image_url: url, email_html: emailHtml }).eq('id', d.id);
      if (d.page_slug) await supabase.from('landing_pages').update({ image_url: url }).eq('slug', d.page_slug);
      processed++;
    } catch { failed++; }
  }

  const { count } = await supabase.from('cold_email_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'ready')
    .not('email_html', 'like', '%font-family:Arial%');
  return NextResponse.json({ ok: true, processed, failed, remaining: count ?? 0 });
}
