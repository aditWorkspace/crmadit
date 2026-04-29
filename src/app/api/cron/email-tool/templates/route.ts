// Templates CRUD for the email-tool admin UI. Admin-only.
// Path uses /api/cron/* prefix per project convention (Vercel deployment-
// protection HTML-404 workaround). Not actually a cron route.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { lintTemplate } from '@/lib/email-tool/lint';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_template_variants')
    .select('*')
    .order('founder_id', { ascending: true })
    .order('label', { ascending: true });
  if (error) {
    console.error('[email-tool/templates GET]', error);
    return NextResponse.json({ error: 'database_error', reason: 'database_error' }, { status: 500 });
  }
  return NextResponse.json({ variants: data ?? [] });
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  const { founder_id, label, subject_template, body_template, override_warnings } = body;
  if (!founder_id || !label || !subject_template || !body_template) {
    return NextResponse.json({ error: 'founder_id, label, subject_template, body_template are required' }, { status: 400 });
  }
  const lint = lintTemplate({ subject_template, body_template });
  if (lint.blockers.length > 0) {
    return NextResponse.json({ error: 'lint blockers', issues: lint }, { status: 400 });
  }
  if (lint.warnings.length > 0 && !override_warnings) {
    return NextResponse.json(
      { error: 'lint warnings — pass override_warnings=true to save', issues: lint },
      { status: 409 }
    );
  }
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_template_variants')
    .insert({ founder_id, label, subject_template, body_template, is_active: true })
    .select('*')
    .single();
  if (error) {
    // Handle the unique(founder_id, label) violation gracefully
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'a variant with that label already exists for this founder' }, { status: 409 });
    }
    console.error('[email-tool/templates POST]', error);
    return NextResponse.json({ error: 'database_error', reason: 'database_error' }, { status: 500 });
  }
  return NextResponse.json({ variant: data });
}
