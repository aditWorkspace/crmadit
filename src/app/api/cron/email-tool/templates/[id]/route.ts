import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { lintTemplate } from '@/lib/email-tool/lint';

interface RouteParams { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, ctx: RouteParams) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  const { label, subject_template, body_template, is_active, override_warnings } = body;

  // Lint runs only when content fields are being edited.
  if (subject_template !== undefined || body_template !== undefined) {
    // Need both fields to lint. If only one is being PATCHed, fetch the other.
    const supabase0 = createAdminClient();
    const { data: existing } = await supabase0
      .from('email_template_variants')
      .select('subject_template, body_template')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: 'variant not found' }, { status: 404 });
    const lint = lintTemplate({
      subject_template: subject_template ?? (existing as { subject_template: string }).subject_template,
      body_template: body_template ?? (existing as { body_template: string }).body_template,
    });
    if (lint.blockers.length > 0) {
      return NextResponse.json({ error: 'lint blockers', issues: lint }, { status: 400 });
    }
    if (lint.warnings.length > 0 && !override_warnings) {
      return NextResponse.json(
        { error: 'lint warnings — pass override_warnings=true', issues: lint },
        { status: 409 }
      );
    }
  }

  const supabase = createAdminClient();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (label !== undefined) updates.label = label;
  if (subject_template !== undefined) updates.subject_template = subject_template;
  if (body_template !== undefined) updates.body_template = body_template;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabase
    .from('email_template_variants')
    .update(updates)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'label collision with an existing variant for this founder' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'variant not found' }, { status: 404 });
  return NextResponse.json({ variant: data });
}

export async function DELETE(req: NextRequest, ctx: RouteParams) {
  // Soft delete: sets is_active=false. Hard DELETE would break the FK from
  // historical email_send_queue rows that reference this variant.
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const { id } = await ctx.params;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_template_variants')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'variant not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
