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

// Rows the first-reply responder flagged with `NEEDS_FOUNDER:` in reason —
// either prospect sent a calendar link or asked a deep technical question.
// Surfaced in the digest so they get handled within the day.
interface NeedsFounderRow {
  lead_id: string;
  contact_name: string;
  company_name: string;
  owner_name: string;
  // 'calendly_sent' | 'question_compliance' | 'question_technical' | 'question_pricing' | 'referral_named' | 'referral_unknown' | other
  kind: string;
  reason: string;
}

interface OutreachFounderRow {
  founder_name: string;
  sent: number;
  bounced: number;
  failed: number;
  replies: number;
  top_variant_label: string | null;
  top_variant_reply_rate: number | null;
}

interface OutreachDigestData {
  founders: OutreachFounderRow[];
  pool_runway_days: number;
  warmup_day: number;
  send_mode: string;
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

  // Pre-fetch departed founder names so each section can label their leads
  // as "(frozen)" — per D1: keep the leads visible in the digest, but make
  // it clear they won't auto-update because the founder no longer has an
  // active Gmail / send pipeline.
  const { data: departedRows } = await supabase
    .from('team_members')
    .select('name')
    .not('departed_at', 'is', null);
  const departedNames = new Set(((departedRows ?? []) as Array<{ name: string }>).map(r => r.name));
  const labelOwner = (name: string | undefined | null): string => {
    if (!name) return '';
    return departedNames.has(name) ? `${name} (frozen)` : name;
  };

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
        owner_name: labelOwner(member?.name),
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
      owner_name: labelOwner(member?.name),
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
        owner_name: labelOwner(member?.name),
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
      owner_name: labelOwner(member?.name),
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
      owner_name: labelOwner(member?.name),
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
      owner_name: labelOwner(member?.name),
    };
  });

  // 8. NEEDS_FOUNDER manual-review rows. The responder tags calendly_sent /
  //    question_only with a "NEEDS_FOUNDER:" reason prefix so we can pick them
  //    out without a schema change. `ilike` matches case-insensitively and
  //    anchors to the start of the field.
  const { data: needsFounderData } = await supabase
    .from('follow_up_queue')
    .select(
      'lead_id, reason, lead:leads(contact_name, company_name, owned_by_member:team_members!leads_owned_by_fkey(name))'
    )
    .eq('type', 'first_reply_manual_review')
    .eq('status', 'pending')
    .ilike('reason', 'NEEDS_FOUNDER:%')
    .order('created_at', { ascending: false })
    .limit(20);

  const needsFounderRows: NeedsFounderRow[] = (needsFounderData || []).map((r) => {
    const lead = r.lead as
      | { contact_name?: string; company_name?: string; owned_by_member?: { name?: string } | null }
      | null;
    const member = lead?.owned_by_member as { name?: string } | null;
    const reasonStr = (r.reason ?? '') as string;
    // Reason shape: "NEEDS_FOUNDER: <classification>: <llm reason>"
    const kindMatch = reasonStr.match(/NEEDS_FOUNDER:\s*(\w+)/i);
    const kind = kindMatch?.[1] ?? 'other';
    return {
      lead_id: r.lead_id,
      contact_name: lead?.contact_name ?? 'Unknown',
      company_name: lead?.company_name ?? '',
      owner_name: labelOwner(member?.name),
      kind,
      reason: reasonStr,
    };
  });

  // ── Build content ──────────────────────────────────────────────────────────

  const dateLabel = format(now, 'EEEE, MMMM d yyyy');
  const subject = `Proxi CRM Daily Digest — ${format(now, 'MMM d')}`;

  // ── Text version ───────────────────────────────────────────────────────────

  const nudgeLabel = (kind: string): string => {
    if (kind === 'calendly_sent') return 'prospect sent a calendar link - log in and book';
    if (kind === 'question_compliance') return 'prospect asked a compliance question (SOC2, GDPR, etc.)';
    if (kind === 'question_technical') return 'prospect asked a technical question (integrations, API, etc.)';
    if (kind === 'question_pricing') return 'prospect asked about pricing';
    if (kind.startsWith('referral_')) return 'prospect referred us to someone else';
    return 'needs founder attention';
  };

  const lines: string[] = [
    `Proxi CRM Daily Digest`,
    `${dateLabel}`,
    ``,
    `PIPELINE SUMMARY`,
    `Total active leads: ${totalActive ?? 0}`,
    ``,
  ];

  if (needsFounderRows.length > 0) {
    lines.push(`NEEDS FOUNDER ATTENTION TODAY (${needsFounderRows.length})`);
    for (const r of needsFounderRows) {
      lines.push(
        `  • ${r.contact_name} (${r.company_name}) — ${nudgeLabel(r.kind)} [${r.owner_name}]`
      );
    }
    lines.push('');
  }

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

  // ── Granola sync health ────────────────────────────────────────────────
  // Counts only Granola-sourced transcripts (those carrying a granola_note_id)
  // imported in the last 24h. Manual paste/uploads don't count toward the
  // automation health number.
  const { count: granolaImported24h } = await supabase
    .from('transcripts')
    .select('id', { count: 'exact', head: true })
    .not('granola_note_id', 'is', null)
    .gte('created_at', yesterday);

  const { data: granolaSyncRows } = await supabase
    .from('granola_sync_state')
    .select('api_key_label, last_run_at, last_error');

  const granolaErrors = (granolaSyncRows || []).filter(r => r.last_error);
  const granolaStaleKeys = (granolaSyncRows || []).filter(r => {
    if (!r.last_run_at) return true;
    return (now.getTime() - new Date(r.last_run_at).getTime()) > 2 * 60 * 60 * 1000;
  });

  // ── PR 5: Yesterday's cold outreach ──────────────────────────────────────
  const outreachData = await getYesterdayOutreachData(supabase);

  // Outreach text section
  const outreachText = outreachData
    ? `\nYESTERDAY'S COLD OUTREACH (${outreachData.send_mode}, warmup day ${outreachData.warmup_day}):\n` +
      outreachData.founders.map(f =>
        `  - ${f.founder_name}: sent ${f.sent}, ${f.bounced} bounced, ${f.replies} replies${f.top_variant_label ? ` (top variant: ${f.top_variant_label})` : ''}`
      ).join('\n') +
      `\n  Pool runway: ${outreachData.pool_runway_days} days remaining\n`
    : '';

  if (outreachText) {
    lines.push(outreachText);
  }

  // Granola text section. Always present so a sudden zero is visible.
  const granolaTextLines: string[] = [
    `GRANOLA SYNC: ${granolaImported24h ?? 0} transcript${granolaImported24h === 1 ? '' : 's'} imported in last 24h`,
  ];
  if (granolaErrors.length > 0) {
    for (const err of granolaErrors) {
      granolaTextLines.push(`  ⚠ ${err.api_key_label} error: ${err.last_error}`);
    }
  }
  if (granolaStaleKeys.length > 0) {
    for (const stale of granolaStaleKeys) {
      const ageMin = stale.last_run_at
        ? Math.round((now.getTime() - new Date(stale.last_run_at).getTime()) / 60000)
        : null;
      granolaTextLines.push(`  ⚠ ${stale.api_key_label} cron stale: last run ${ageMin !== null ? ageMin + 'm ago' : 'never'}`);
    }
  }
  lines.push('');
  lines.push(...granolaTextLines);

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

  const needsFounderSection =
    needsFounderRows.length > 0
      ? `
        <div style="margin-bottom:24px;padding:12px 16px;border:1px solid #fecdd3;background:#fff1f2;border-radius:8px;">
          <h2 style="font-size:14px;font-weight:700;color:#9f1239;margin:0 0 8px;">
            Needs founder attention today (${needsFounderRows.length})
          </h2>
          <ul style="margin:0;padding-left:20px;list-style:disc;">
            ${needsFounderRows
              .map((r) =>
                listItem(
                  `<strong>${escHtml(r.contact_name)}</strong> ` +
                    `(${escHtml(r.company_name)}) — ` +
                    `<span style="color:#9f1239;">${escHtml(nudgeLabel(r.kind))}</span> ` +
                    `<span style="color:#9ca3af;">[${escHtml(r.owner_name)}]</span>`
                )
              )
              .join('')}
          </ul>
        </div>`
      : '';

  const outreachSection = outreachData
    ? section(
        `Yesterday's Cold Outreach (${outreachData.send_mode}, warmup day ${outreachData.warmup_day})`,
        `<table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="text-align:left;color:#6b7280;font-size:12px;">
              <th style="padding:4px 8px;">Founder</th>
              <th style="padding:4px 8px;">Sent</th>
              <th style="padding:4px 8px;">Bounced</th>
              <th style="padding:4px 8px;">Replies</th>
              <th style="padding:4px 8px;">Top variant</th>
            </tr>
          </thead>
          <tbody>
            ${outreachData.founders.map(f => `
              <tr style="border-top:1px solid #f3f4f6;">
                <td style="padding:4px 8px;font-weight:500;">${escHtml(f.founder_name)}</td>
                <td style="padding:4px 8px;">${f.sent}</td>
                <td style="padding:4px 8px;color:${f.bounced > 0 ? '#dc2626' : '#6b7280'};">${f.bounced}</td>
                <td style="padding:4px 8px;color:#16a34a;">${f.replies}</td>
                <td style="padding:4px 8px;color:#6b7280;">${escHtml(f.top_variant_label ?? '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <p style="margin:8px 0 0;font-size:12px;color:#9ca3af;">
          Pool runway: ${outreachData.pool_runway_days} days remaining
        </p>`
      )
    : '';

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

  // Granola health HTML — always rendered so a zero is visible.
  const granolaHasIssue = granolaErrors.length > 0 || granolaStaleKeys.length > 0;
  const granolaSection = `
    <div style="margin-bottom:24px;padding:12px 14px;border-radius:8px;border:1px solid ${granolaHasIssue ? '#fecaca' : '#bbf7d0'};background:${granolaHasIssue ? '#fef2f2' : '#f0fdf4'};">
      <p style="margin:0;font-size:13px;color:${granolaHasIssue ? '#991b1b' : '#166534'};">
        <strong>Granola sync:</strong> ${granolaImported24h ?? 0} transcript${granolaImported24h === 1 ? '' : 's'} imported in last 24h
      </p>
      ${granolaHasIssue ? `
      <ul style="margin:6px 0 0 18px;padding:0;font-size:12px;color:#991b1b;">
        ${granolaErrors.map(e => `<li>${escHtml(e.api_key_label)} error: ${escHtml(e.last_error || '')}</li>`).join('')}
        ${granolaStaleKeys.map(s => {
          const ageMin = s.last_run_at ? Math.round((now.getTime() - new Date(s.last_run_at).getTime()) / 60000) : null;
          return `<li>${escHtml(s.api_key_label)} cron stale: last run ${ageMin !== null ? ageMin + 'm ago' : 'never'}</li>`;
        }).join('')}
      </ul>` : ''}
    </div>`;

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
        <strong>${staleLeads.length}</strong> stale${overdueActions.length > 0 ? ` &nbsp;·&nbsp; <span style="color:#ef4444;"><strong>${overdueActions.length}</strong> overdue tasks</span>` : ''}${needsFounderRows.length > 0 ? ` &nbsp;·&nbsp; <span style="color:#9f1239;"><strong>${needsFounderRows.length}</strong> need founder</span>` : ''}
      </p>
    </div>
    <!-- Body -->
    <div style="padding:24px 32px;">
      ${needsFounderSection}
      ${granolaSection}
      ${outreachSection}
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

async function getYesterdayOutreachData(
  supabase: ReturnType<typeof createAdminClient>
): Promise<OutreachDigestData | null> {
  // Yesterday's PT date as YYYY-MM-DD
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const yesterdayKey = fmt.format(yesterday);

  // Did a campaign run yesterday?
  const { data: campaignRow } = await supabase
    .from('email_send_campaigns')
    .select('id, status, send_mode, warmup_day')
    .eq('idempotency_key', yesterdayKey)
    .maybeSingle();
  if (!campaignRow) return null; // No campaign yesterday — section is omitted

  const campaign = campaignRow as { id: string; status: string; send_mode: string; warmup_day: number | null };

  // Per-founder counts via direct queue inspection
  const { data: queueRows } = await supabase
    .from('email_send_queue')
    .select('account_id, status, last_error, template_variant_id, recipient_email')
    .eq('campaign_id', campaign.id);
  const queue = (queueRows ?? []) as Array<{
    account_id: string;
    status: string;
    last_error: string | null;
    template_variant_id: string | null;
    recipient_email: string;
  }>;

  // Replies — leads with first_reply_at AFTER campaign queue rows landed
  const recipientEmails = queue.map(r => r.recipient_email);
  const repliedEmails = new Set<string>();
  if (recipientEmails.length > 0) {
    const yesterdayStart = new Date(yesterday);
    yesterdayStart.setHours(0, 0, 0, 0);
    const yesterdayStartIso = yesterdayStart.toISOString();
    const { data: repliedLeads } = await supabase
      .from('leads')
      .select('contact_email')
      .in('contact_email', recipientEmails)
      .gte('first_reply_at', yesterdayStartIso);
    for (const l of (repliedLeads ?? []) as Array<{ contact_email: string }>) {
      repliedEmails.add(l.contact_email.toLowerCase());
    }
  }

  // Founder names
  const accountIds = Array.from(new Set(queue.map(r => r.account_id)));
  const { data: foundersData } = await supabase
    .from('team_members')
    .select('id, name')
    .in('id', accountIds);
  const founderNames = new Map(
    ((foundersData ?? []) as Array<{ id: string; name: string }>).map(f => [f.id, f.name])
  );

  // Variant labels
  const variantIds = Array.from(new Set(queue.map(r => r.template_variant_id).filter((v): v is string => v != null)));
  const { data: variantsData } = await supabase
    .from('email_template_variants')
    .select('id, label, founder_id')
    .in('id', variantIds);
  const variantInfo = new Map(
    ((variantsData ?? []) as Array<{ id: string; label: string; founder_id: string }>)
      .map(v => [v.id, v])
  );

  // Aggregate per-founder
  const founders: OutreachFounderRow[] = [];
  for (const accountId of accountIds) {
    const rows = queue.filter(r => r.account_id === accountId);
    const sent = rows.filter(r => r.status === 'sent').length;
    const bounced = rows.filter(r => r.last_error?.startsWith('hard_bounce')).length;
    const failed = rows.filter(r => r.status === 'failed' && !r.last_error?.startsWith('hard_bounce')).length;
    const replies = rows.filter(r => repliedEmails.has(r.recipient_email)).length;

    // Top variant for this founder yesterday: count sends per variant
    const variantCounts = new Map<string, number>();
    for (const r of rows.filter(r => r.status === 'sent' && r.template_variant_id)) {
      const k = r.template_variant_id!;
      variantCounts.set(k, (variantCounts.get(k) ?? 0) + 1);
    }
    let topVariantId: string | null = null;
    let topCount = 0;
    for (const [vid, c] of variantCounts) {
      if (c > topCount) { topVariantId = vid; topCount = c; }
    }
    const topVariantLabel = topVariantId ? variantInfo.get(topVariantId)?.label ?? null : null;

    founders.push({
      founder_name: founderNames.get(accountId) ?? 'Unknown',
      sent,
      bounced,
      failed,
      replies,
      top_variant_label: topVariantLabel,
      top_variant_reply_rate: null, // TODO: per-variant reply rate over 30d (could use email_send_variant_stats_30d RPC)
    });
  }

  // Pool runway
  const { data: freshRemaining } = await supabase.rpc('email_tool_fresh_remaining');
  const pool_runway_days = Math.floor(Number(freshRemaining ?? 0) / 1200);

  return {
    founders,
    pool_runway_days,
    warmup_day: campaign.warmup_day ?? 0,
    send_mode: campaign.send_mode,
  };
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
