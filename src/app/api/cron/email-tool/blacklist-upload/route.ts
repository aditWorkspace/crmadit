// POST /api/cron/email-tool/blacklist-upload — admin-only CSV upload.
// Accepts multipart form-data with one or more `files` fields. Extracts
// every email-looking string via regex (column-agnostic), lowercases,
// dedups, and bulk-inserts with ON CONFLICT DO NOTHING. Returns the
// actual newly-inserted delta + totals.
export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { addToBlacklistFromUpload } from '@/lib/email-tool/pool';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ ok: false, reason: 'unauthenticated' }, { status: 401 });
  if (!session.is_admin) return NextResponse.json({ ok: false, reason: 'forbidden' }, { status: 403 });

  let files: File[];
  try {
    const form = await req.formData();
    files = form.getAll('files').filter((v): v is File => typeof v !== 'string');
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad_form' }, { status: 400 });
  }

  if (files.length === 0) {
    return NextResponse.json({ ok: false, reason: 'no_files' }, { status: 400 });
  }

  const collected = new Set<string>();
  for (const file of files) {
    const text = await file.text();
    const matches = text.match(EMAIL_RE);
    if (!matches) continue;
    for (const m of matches) collected.add(m.toLowerCase());
  }

  const result = await addToBlacklistFromUpload(Array.from(collected));

  return NextResponse.json({
    ok: true,
    filesParsed: files.length,
    uniqueEmailsFound: result.uniqueInput,
    newlyAdded: result.newlyAdded,
    totalAfter: result.totalAfter,
    freshRemaining: result.freshRemaining,
  });
}
