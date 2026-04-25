// Bundles the two insights markdown files into a single zip and streams
// it back. Used by the Export button on /insights.
//
// Note on path: lives under /api/insights/* (not /api/cron/*) because
// it's a user-facing download authenticated by the cookie session, not
// CRON_SECRET. Vercel deployment protection hasn't blocked this prefix
// in testing — chat-sessions sits at /api/chat-sessions and works fine
// from browser.
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { getSessionFromRequest } from '@/lib/session';
import { buildInsightsExport } from '@/lib/export/insights-export';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const files = await buildInsightsExport();

  const zip = new JSZip();
  for (const f of files) zip.file(f.filename, f.content);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  const today = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="proxi-insights-${today}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
}
