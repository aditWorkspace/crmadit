// POST — regenerate the whiteboard image for a draft, optionally with extra
// free-text instructions. Returns a NEW candidate image (uploaded to a
// candidates/ key) WITHOUT applying it — the dashboard shows base + current +
// new so the sender can pick. Admin-only.
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { regenerateLeadImage, referenceImageUrl } from '@/lib/ai/visual-draft';

export const runtime = 'nodejs';
export const maxDuration = 120;

async function authorized(req: NextRequest): Promise<boolean> {
  if (req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`) return true;
  const session = await getSessionFromRequest(req);
  return !!session?.is_admin;
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const id = body?.id as string | undefined;
  const prompt = body?.prompt as string | undefined;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data: draft } = await supabase
    .from('cold_email_drafts')
    .select('id, first_name, company, image_url')
    .eq('id', id)
    .maybeSingle();
  if (!draft) return NextResponse.json({ error: 'draft not found' }, { status: 404 });
  const d = draft as { id: string; first_name: string | null; company: string | null; image_url: string | null };

  const key = `candidates/${id}-${Date.now()}.jpg`;
  let url: string | null;
  try {
    url = await regenerateLeadImage(supabase, { first: d.first_name ?? 'there', company: d.company ?? '', extraPrompt: prompt, key });
  } catch (err) {
    return NextResponse.json({ error: 'image_gen_failed', detail: (err as Error).message.slice(0, 160) }, { status: 500 });
  }
  if (!url) return NextResponse.json({ error: 'no_reference_image configured' }, { status: 400 });

  return NextResponse.json({ ok: true, image_url: url, reference_url: referenceImageUrl(supabase), current_url: d.image_url });
}
