import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { buildDailyDigest } from '@/lib/automation/digest-builder';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    return NextResponse.json({ error: 'RESEND_API_KEY not configured' }, { status: 500 });
  }

  // Build digest
  const { subject, html } = await buildDailyDigest();

  // Fetch team member emails
  const supabase = createAdminClient();
  const { data: members, error } = await supabase
    .from('team_members')
    .select('id, name, email');

  if (error || !members?.length) {
    return NextResponse.json({ error: 'Failed to fetch team members' }, { status: 500 });
  }

  const emails = members.map((m) => m.email).filter(Boolean) as string[];

  if (emails.length === 0) {
    return NextResponse.json({ status: 'no recipients configured' });
  }

  // Send via Resend
  const results: { email: string; ok: boolean; error?: string }[] = [];

  for (const email of emails) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Proxi CRM <digest@proxi.ai>',
          to: [email],
          subject,
          html,
        }),
      });

      if (res.ok) {
        results.push({ email, ok: true });
      } else {
        const body = await res.json().catch(() => ({}));
        results.push({ email, ok: false, error: (body as { message?: string }).message ?? String(res.status) });
      }
    } catch (err) {
      results.push({ email, ok: false, error: err instanceof Error ? err.message : 'unknown' });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  return NextResponse.json({ status: 'done', sent, failed, results });
}
