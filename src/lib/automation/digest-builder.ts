import { createAdminClient } from '@/lib/supabase/admin';
import { STALE_THRESHOLDS, ACTIVE_STAGES, STAGE_LABELS } from '@/lib/constants';
import { LeadStage } from '@/types';
import { subDays, differenceInHours, format } from 'date-fns';

interface LeadMoved {
  contact_name: string;
  company_name: string;
  from_stage: string;
  to_stage: string;
  owner_name: string;
}

interface NewLead {
  contact_name: string;
  company_name: string;
  owner_name: string;
}

interface StaleLead {
  contact_name: string;
  company_name: string;
  stage: string;
  hours_stale: number;
  owner_name: string;
}

interface ActionDue {
  text: string;
  lead_name: string;
  due_date: string;
  owner_name: string;
}

interface OverdueAction {
  text: string;
  lead_name: string;
  due_date: string;
  owner_name: string;
  days_overdue: number;
}

interface TopPriorityLead {
  contact_name: string;
  company_name: string;
  stage: string;
  heat_score: number;
  ai_next_action: string;
  owner_name: string;
}

export async function buildDailyDigest(): Promise<{
  subject: string;
  html: string;
  text: string;
}> {
  const supabase = createAdminClient();
  const now = new Date();
  const yesterday = subDays(now, 1).toISOString();
  const todayStr = format(now, 'yyyy-MM-dd');

  // 1. Leads that moved stages yesterday
  const { data: stageChanges } = await supabase
    .from('activity_log')
    .select(
      'lead_id, details, created_at, lead:leads(contact_name, company_name), team_member:team_members(name)'
    )
    .eq('action', 'stage_changed')
    .gte('created_at', yesterday)
    .order('created_at', { ascending: false })
    .limit(50);

  const leadsMovedForward: LeadMoved[] = (stageChanges || [])
    .filter((a) => {
      const to = (a.details as { to?: string } | null)?.to;
      return to && to !== 'dead';
    })
    .map((a) => {
      const lead = a.lead as { contact_name?: string; company_name?: string } | null;
      const member = a.team_member as { name?: string } | null;
      const details = a.details as { from?: string; to?: string } | null;
      return {
        contact_name: lead?.contact_name ?? 'Unknown',
        company_name: lead?.company_name ?? '',
        from_stage: details?.from ?? '',
        to_stage: details?.to ?? '',
        owner_name: member?.name ?? '',
      };
    });

  // 2. New leads added yesterday
  const { data: newLeadsData } = await supabase
    .from('leads')
    .select('contact_name, company_name, owned_by_member:team_members!leads_owned_by_fkey(name)')
    .gte('created_at', yesterday)
    .eq('is_archived', false)
    .limit(50);

  const newLeads: NewLead[] = (newLeadsData || []).map((l) => {
    const member = l.owned_by_member as { name?: string } | null;
    return {
      contact_name: l.contact_name,
      company_name: l.company_name,
      owner_name: member?.name ?? '',
    };
  });

  // 3. Stale leads
  const { data: activeLeads } = await supabase
    .from('leads')
    .select(
      'contact_name, company_name, stage, last_contact_at, owned_by_member:team_members!leads_owned_by_fkey(name)'
    )
    .in('stage', ACTIVE_STAGES)
    .eq('is_archived', false);

  const staleLeads: StaleLead[] = (activeLeads || [])
    .filter((l) => {
      const threshold = STALE_THRESHOLDS[l.stage as LeadStage];
      if (!threshold || !l.last_contact_at) return false;
      return differenceInHours(now, new Date(l.last_contact_at)) > threshold;
    })
    .map((l) => {
      const member = l.owned_by_member as { name?: string } | null;
      return {
        contact_name: l.contact_name,
        company_name: l.company_name,
        stage: l.stage,
        hours_stale: Math.round(differenceInHours(now, new Date(l.last_contact_at!))),
        owner_name: member?.name ?? '',
      };
    })
    .sort((a, b) => b.hours_stale - a.hours_stale)
    .slice(0, 10);

  // 4. Total active leads
  const { count: totalActive } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .in('stage', ACTIVE_STAGES)
    .eq('is_archived', false);

  // 5. Action items due today
  const { data: actionItemsData } = await supabase
    .from('action_items')
    .select(
      'text, due_date, lead:leads(contact_name), assigned_member:team_members(name)'
    )
    .eq('completed', false)
    .eq('due_date', todayStr)
    .limit(30);

  const actionsDueToday: ActionDue[] = (actionItemsData || []).map((a) => {
    const lead = a.lead as { contact_name?: string } | null;
    const member = a.assigned_member as { name?: string } | null;
    return {
      text: a.text,
      lead_name: lead?.contact_name ?? 'Unknown',
      due_date: a.due_date,
      owner_name: member?.name ?? '',
    };
  });

  // 6. Overdue action items (due before today and not completed)
  const { data: overdueItemsData } = await supabase
    .from('action_items')
    .select(
      'text, due_date, lead:leads(contact_name), assigned_member:team_members(name)'
    )
    .eq('completed', false)
    .lt('due_date', todayStr)
    .order('due_date', { ascending: true })
    .limit(20);

  const overdueActions: OverdueAction[] = (overdueItemsData || []).map((a) => {
    const lead = a.lead as { contact_name?: string } | null;
    const member = a.assigned_member as { name?: string } | null;
    const daysOverdue = Math.ceil(
      (now.getTime() - new Date(a.due_date).getTime()) / (1000 * 60 * 60 * 24)
    );
    return {
      text: a.text,
      lead_name: lead?.contact_name ?? 'Unknown',
      due_date: a.due_date,
      owner_name: member?.name ?? '',
      days_overdue: daysOverdue,
    };
  });

  // 7. Top priority leads by heat_score with AI next action
  const { data: topLeadsData } = await supabase
    .from('leads')
    .select(
      'contact_name, company_name, stage, heat_score, ai_next_action, owned_by_member:team_members!leads_owned_by_fkey(name)'
    )
    .in('stage', ACTIVE_STAGES)
    .eq('is_archived', false)
    .not('ai_next_action', 'is', null)
    .order('heat_score', { ascending: false })
    .limit(5);

  const topPriorityLeads: TopPriorityLead[] = (topLeadsData || []).map((l) => {
    const member = l.owned_by_member as { name?: string } | null;
    return {
      contact_name: l.contact_name,
      company_name: l.company_name,
      stage: l.stage,
      heat_score: l.heat_score,
      ai_next_action: l.ai_next_action!,
      owner_name: member?.name ?? '',
    };
  });

  // ── Build content ──────────────────────────────────────────────────────────

  const dateLabel = format(now, 'EEEE, MMMM d yyyy');
  const subject = `Proxi CRM Daily Digest — ${format(now, 'MMM d')}`;

  // ── Text version ───────────────────────────────────────────────────────────

  const lines: string[] = [
    `Proxi CRM Daily Digest`,
    `${dateLabel}`,
    ``,
    `PIPELINE SUMMARY`,
    `Total active leads: ${totalActive ?? 0}`,
    ``,
  ];

  if (leadsMovedForward.length > 0) {
    lines.push(`LEADS MOVED FORWARD YESTERDAY (${leadsMovedForward.length})`);
    for (const l of leadsMovedForward) {
      const from = STAGE_LABELS[l.from_stage as LeadStage] ?? l.from_stage;
      const to = STAGE_LABELS[l.to_stage as LeadStage] ?? l.to_stage;
      lines.push(`  • ${l.contact_name} (${l.company_name}) — ${from} → ${to} [${l.owner_name}]`);
    }
    lines.push('');
  }

  if (newLeads.length > 0) {
    lines.push(`NEW LEADS YESTERDAY (${newLeads.length})`);
    for (const l of newLeads) {
      lines.push(`  • ${l.contact_name} (${l.company_name}) — owned by ${l.owner_name}`);
    }
    lines.push('');
  }

  if (staleLeads.length > 0) {
    lines.push(`STALE LEADS (${staleLeads.length})`);
    for (const l of staleLeads) {
      const stage = STAGE_LABELS[l.stage as LeadStage] ?? l.stage;
      lines.push(
        `  • ${l.contact_name} (${l.company_name}) — ${l.hours_stale}h in ${stage} [${l.owner_name}]`
      );
    }
    lines.push('');
  }

  if (actionsDueToday.length > 0) {
    lines.push(`ACTION ITEMS DUE TODAY (${actionsDueToday.length})`);
    for (const a of actionsDueToday) {
      lines.push(`  • [${a.owner_name}] ${a.text} — re: ${a.lead_name}`);
    }
    lines.push('');
  }

  if (overdueActions.length > 0) {
    lines.push(`OVERDUE ACTION ITEMS (${overdueActions.length})`);
    for (const a of overdueActions) {
      lines.push(`  • [${a.owner_name}] ${a.text} — re: ${a.lead_name} (${a.days_overdue}d overdue)`);
    }
    lines.push('');
  }

  if (topPriorityLeads.length > 0) {
    lines.push(`TOP PRIORITY NEXT STEPS`);
    for (const l of topPriorityLeads) {
      const stage = STAGE_LABELS[l.stage as LeadStage] ?? l.stage;
      lines.push(`  • ${l.contact_name} (${l.company_name}) [${stage}] — ${l.ai_next_action} [${l.owner_name}]`);
    }
    lines.push('');
  }

  if (staleLeads.length === 0 && leadsMovedForward.length === 0) {
    lines.push('No significant pipeline activity yesterday.');
  }

  const text = lines.join('\n');

  // ── HTML version ───────────────────────────────────────────────────────────

  const stageLabel = (s: string) => STAGE_LABELS[s as LeadStage] ?? s;

  const section = (title: string, body: string) => `
    <div style="margin-bottom:24px;">
      <h2 style="font-size:14px;font-weight:600;color:#374151;margin:0 0 8px;">${title}</h2>
      ${body}
    </div>`;

  const listItem = (content: string) =>
    `<li style="padding:4px 0;color:#374151;font-size:14px;">${content}</li>`;

  const ul = (items: string[]) =>
    `<ul style="margin:0;padding-left:20px;list-style:disc;">${items.join('')}</ul>`;

  const movedSection =
    leadsMovedForward.length > 0
      ? section(
          `Leads Moved Forward Yesterday (${leadsMovedForward.length})`,
          ul(
            leadsMovedForward.map((l) =>
              listItem(
                `<strong>${escHtml(l.contact_name)}</strong> (${escHtml(l.company_name)}) — ` +
                  `${escHtml(stageLabel(l.from_stage))} → <strong>${escHtml(stageLabel(l.to_stage))}</strong> ` +
                  `<span style="color:#9ca3af;">[${escHtml(l.owner_name)}]</span>`
              )
            )
          )
        )
      : '';

  const newSection =
    newLeads.length > 0
      ? section(
          `New Leads Yesterday (${newLeads.length})`,
          ul(
            newLeads.map((l) =>
              listItem(
                `<strong>${escHtml(l.contact_name)}</strong> (${escHtml(l.company_name)}) — ` +
                  `<span style="color:#9ca3af;">owned by ${escHtml(l.owner_name)}</span>`
              )
            )
          )
        )
      : '';

  const staleSection =
    staleLeads.length > 0
      ? section(
          `Stale Leads (${staleLeads.length})`,
          ul(
            staleLeads.map((l) =>
              listItem(
                `<span style="color:#ef4444;font-weight:600;">${escHtml(l.contact_name)}</span> ` +
                  `(${escHtml(l.company_name)}) — ${l.hours_stale}h in ${escHtml(stageLabel(l.stage))} ` +
                  `<span style="color:#9ca3af;">[${escHtml(l.owner_name)}]</span>`
              )
            )
          )
        )
      : '';

  const actionsSection =
    actionsDueToday.length > 0
      ? section(
          `Action Items Due Today (${actionsDueToday.length})`,
          ul(
            actionsDueToday.map((a) =>
              listItem(
                `<span style="color:#6366f1;">[${escHtml(a.owner_name)}]</span> ` +
                  `${escHtml(a.text)} — <em>${escHtml(a.lead_name)}</em>`
              )
            )
          )
        )
      : '';

  const overdueSection =
    overdueActions.length > 0
      ? section(
          `Overdue Action Items (${overdueActions.length})`,
          ul(
            overdueActions.map((a) =>
              listItem(
                `<span style="color:#ef4444;font-weight:600;">[${escHtml(a.owner_name)}]</span> ` +
                  `${escHtml(a.text)} — <em>${escHtml(a.lead_name)}</em> ` +
                  `<span style="color:#ef4444;">(${a.days_overdue}d overdue)</span>`
              )
            )
          )
        )
      : '';

  const topPrioritySection =
    topPriorityLeads.length > 0
      ? section(
          `Top Priority Next Steps`,
          ul(
            topPriorityLeads.map((l) =>
              listItem(
                `<strong>${escHtml(l.contact_name)}</strong> (${escHtml(l.company_name)}) ` +
                  `<span style="color:#6366f1;">[${escHtml(stageLabel(l.stage))}]</span> — ` +
                  `${escHtml(l.ai_next_action)} ` +
                  `<span style="color:#9ca3af;">[${escHtml(l.owner_name)}]</span>`
              )
            )
          )
        )
      : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:0;">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">
    <!-- Header -->
    <div style="background:#111827;padding:24px 32px;">
      <p style="color:#fff;font-size:20px;font-weight:700;margin:0;">Proxi CRM</p>
      <p style="color:#9ca3af;font-size:13px;margin:4px 0 0;">Daily Digest — ${escHtml(dateLabel)}</p>
    </div>
    <!-- Summary bar -->
    <div style="background:#f0fdf4;border-bottom:1px solid #bbf7d0;padding:12px 32px;">
      <p style="color:#166534;font-size:14px;margin:0;">
        <strong>${totalActive ?? 0}</strong> active leads in pipeline &nbsp;·&nbsp;
        <strong>${leadsMovedForward.length}</strong> moved forward &nbsp;·&nbsp;
        <strong>${staleLeads.length}</strong> stale${overdueActions.length > 0 ? ` &nbsp;·&nbsp; <span style="color:#ef4444;"><strong>${overdueActions.length}</strong> overdue tasks</span>` : ''}
      </p>
    </div>
    <!-- Body -->
    <div style="padding:24px 32px;">
      ${movedSection}
      ${newSection}
      ${overdueSection}
      ${staleSection}
      ${actionsSection}
      ${topPrioritySection}
      ${
        !movedSection && !staleSection
          ? '<p style="color:#9ca3af;font-size:14px;">No significant pipeline activity yesterday.</p>'
          : ''
      }
    </div>
    <!-- Footer -->
    <div style="border-top:1px solid #e5e7eb;padding:16px 32px;background:#f9fafb;">
      <p style="color:#9ca3af;font-size:12px;margin:0;">
        Proxi AI CRM &nbsp;·&nbsp; Daily digest sent at 8 AM PT
      </p>
    </div>
  </div>
</body>
</html>`;

  return { subject, html, text };
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Phase 2c: @mention digest section (per recipient) ─────────────────────────

interface MentionDigestRow {
  notification_id: string;
  comment_id: string;
  gmail_thread_id: string;
  author_name: string;
  body: string;
  created_at: string;
}

export interface MentionDigestSection {
  rows: MentionDigestRow[];
  notificationIds: string[];
  html: string; // '' when rows.length === 0
  text: string; // '' when rows.length === 0
}

function snippet(body: string, max = 180): string {
  const trimmed = body.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + '…';
}

/**
 * Build the mentions section for a single recipient — includes unread + not-yet-digested
 * mention notifications. Returns empty html/text if no rows. Does NOT mark the rows
 * as digested — call `markMentionsDigested(notificationIds)` only after the digest
 * email is successfully sent.
 */
export async function getMentionDigestSection(
  memberId: string
): Promise<MentionDigestSection> {
  const supabase = createAdminClient();

  type RawRow = {
    id: string;
    comment_id: string;
    gmail_thread_id: string;
    created_at: string;
    comment: {
      body: string;
      author: { name: string | null } | null;
    } | null;
  };

  const { data, error } = await supabase
    .from('mention_notifications')
    .select(
      `
      id, comment_id, gmail_thread_id, created_at,
      comment:thread_comments!mention_notifications_comment_id_fkey(
        body,
        author:team_members!thread_comments_author_id_fkey(name)
      )
      `
    )
    .eq('recipient_id', memberId)
    .is('read_at', null)
    .is('digested_at', null)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error || !data) {
    return { rows: [], notificationIds: [], html: '', text: '' };
  }

  const rawRows = data as unknown as RawRow[];
  const rows: MentionDigestRow[] = rawRows
    .filter((r) => r.comment !== null)
    .map((r) => ({
      notification_id: r.id,
      comment_id: r.comment_id,
      gmail_thread_id: r.gmail_thread_id,
      author_name: r.comment?.author?.name ?? 'Someone',
      body: r.comment?.body ?? '',
      created_at: r.created_at,
    }));

  if (rows.length === 0) {
    return { rows: [], notificationIds: [], html: '', text: '' };
  }

  const notificationIds = rows.map((r) => r.notification_id);

  // Text section
  const textLines: string[] = [`MENTIONS YOU HAVEN'T SEEN (${rows.length})`];
  for (const r of rows) {
    textLines.push(
      `  • ${r.author_name}: ${snippet(r.body, 140)}  (thread ${r.gmail_thread_id})`
    );
  }
  const text = textLines.join('\n');

  // HTML section (matches existing section() helper style from buildDailyDigest)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
  const items = rows
    .map((r) => {
      const link = appUrl
        ? `${appUrl}/inbox?thread=${encodeURIComponent(r.gmail_thread_id)}`
        : '';
      const linkAttr = link ? ` href="${escHtml(link)}"` : '';
      return `<li style="padding:4px 0;color:#374151;font-size:14px;">
        <strong>${escHtml(r.author_name)}</strong> mentioned you —
        <a${linkAttr} style="color:#6366f1;text-decoration:none;">
          ${escHtml(snippet(r.body, 140))}
        </a>
      </li>`;
    })
    .join('');

  const html = `
    <div style="margin-bottom:24px;">
      <h2 style="font-size:14px;font-weight:600;color:#374151;margin:0 0 8px;">Mentions you haven't seen (${rows.length})</h2>
      <ul style="margin:0;padding-left:20px;list-style:disc;">${items}</ul>
    </div>`;

  return { rows, notificationIds, html, text };
}

/**
 * Atomically mark a batch of mention notifications as digested — call only
 * after the digest email is successfully sent so a failed send doesn't swallow
 * the notifications.
 */
export async function markMentionsDigested(notificationIds: string[]): Promise<void> {
  if (notificationIds.length === 0) return;
  const supabase = createAdminClient();
  await supabase
    .from('mention_notifications')
    .update({ digested_at: new Date().toISOString() })
    .in('id', notificationIds);
}
