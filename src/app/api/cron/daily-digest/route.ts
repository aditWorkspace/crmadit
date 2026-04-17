export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  buildDailyDigest,
  getMentionDigestSection,
  markMentionsDigested,
} from '@/lib/automation/digest-builder';
import { verifyCronAuth } from '@/lib/auth/cron';

/**
 * Inject a per-recipient mentions section into the pre-built digest.
 * We splice the HTML section into the <!-- Body --> container just after the
 * opening tag, and prepend the text section to the plain-text version.
 */
function injectMentionSection(
  baseHtml: string,
  baseText: string,
  mentionHtml: string,
  mentionText: string
): { html: string; text: string } {
  if (!mentionHtml && !mentionText) {
    return { html: baseHtml, text: baseText };
  }

  // HTML: inject right after the Body opening <div style="padding:24px 32px;">
  const bodyMarker = '<!-- Body -->';
  const bodyIdx = baseHtml.indexOf(bodyMarker);
  let html = baseHtml;
  if (bodyIdx !== -1) {
    // Find the opening <div ...> after the marker
    const openTagStart = baseHtml.indexOf('<div', bodyIdx);
    const openTagEnd = openTagStart !== -1 ? baseHtml.indexOf('>', openTagStart) : -1;
    if (openTagEnd !== -1) {
      const insertAt = openTagEnd + 1;
      html = baseHtml.slice(0, insertAt) + mentionHtml + baseHtml.slice(insertAt);
    }
  }

  // Text: prepend mention block so it's visible first
  const text = mentionText
    ? mentionText + '\n\n' + baseText
    : baseText;

  return { html, text };
}

async function handler(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    return NextResponse.json({ error: 'RESEND_API_KEY not configured' }, { status: 500 });
  }

  // Build once — the shared shell of the digest
  const { subject, html: baseHtml, text: baseText } = await buildDailyDigest();

  // Fetch team members with IDs so we can compute per-recipient mentions
  const supabase = createAdminClient();
  const { data: members, error } = await supabase
    .from('team_members')
    .select('id, name, email');

  if (error || !members?.length) {
    return NextResponse.json({ error: 'Failed to fetch team members' }, { status: 500 });
  }

  const results: {
    email: string;
    ok: boolean;
    mentions?: number;
    error?: string;
  }[] = [];

  for (const member of members) {
    if (!member.email) continue;

    // Per-recipient mention section
    const mentionSection = await getMentionDigestSection(member.id);
    const { html, text } = injectMentionSection(
      baseHtml,
      baseText,
      mentionSection.html,
      mentionSection.text
    );

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.DIGEST_FROM_EMAIL || 'Proxi CRM <digest@proxi.ai>',
          to: [member.email],
          subject,
          html,
          text,
        }),
      });

      if (res.ok) {
        // Only mark digested after successful send
        if (mentionSection.notificationIds.length > 0) {
          await markMentionsDigested(mentionSection.notificationIds);
        }
        results.push({
          email: member.email,
          ok: true,
          mentions: mentionSection.rows.length,
        });
      } else {
        const body = await res.json().catch(() => ({}));
        results.push({
          email: member.email,
          ok: false,
          error: (body as { message?: string }).message ?? String(res.status),
        });
      }
    } catch (err) {
      results.push({
        email: member.email,
        ok: false,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  return NextResponse.json({ status: 'done', sent, failed, results });
}

export const GET = handler;
export const POST = handler;
