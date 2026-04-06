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
    .gte('first_reply_at', yesterday)
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
        <strong>${staleLeads.length}</strong> stale
      </p>
    </div>
    <!-- Body -->
    <div style="padding:24px 32px;">
      ${movedSection}
      ${newSection}
      ${staleSection}
      ${actionsSection}
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
