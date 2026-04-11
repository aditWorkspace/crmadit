import { NextResponse } from 'next/server';
import { runFirstReplyAutoResponder } from '@/lib/automation/first-reply-responder';

// Local-only dev route: invokes the first-reply auto-responder in dry-run mode
// so you can inspect classification decisions and drafted messages without
// burning real emails on real prospects. Returns 404 in production.
export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const result = await runFirstReplyAutoResponder({ dryRun: true });

  // Scan generated messages for em dashes — the scrubber should make this
  // impossible, but the dev route is a good place to prove it.
  const emDashHits = (result.details ?? []).filter(
    d => d.message_preview && (d.message_preview.includes('—') || d.message_preview.includes('–'))
  );

  return NextResponse.json({
    ...result,
    em_dash_violations: emDashHits,
  });
}
