// End-to-end cold-email personalization demo. Pulls N random email_pool leads
// and runs the REAL engine (Firecrawl scrape + Perplexity research + DeepSeek
// extraction/verification/writing/claim-check) on each, writing the generated
// email + evidence to a markdown file. No emails are sent — drafts only.
//
// Runs against prod Supabase (reads email_pool/leads/email_blacklist; writes to
// the draft/cache tables are no-ops if migration 038 isn't applied). Requires
// FIRECRAWL_API_KEY, PERPLEXITY_API_KEY, OPENROUTER_API_KEY, SUPABASE_* in env.

import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createAdminClient } from '@/lib/supabase/admin';
import { processDraftRow, type DraftInput, type DraftOutcome } from '@/lib/ai/cold-research';
import type { EvidenceCard } from '@/lib/validation';

const N = Number(process.env.DEMO_N ?? 10);
const OUT = '/Users/adit/CRMMAIN/cold-email-demo-output.md';
const SENDER = { id: 'demo-adit', name: 'Adit Mittal', email: 'aditmittal@berkeley.edu' };

interface PoolRow {
  id: string; sequence: number; company: string | null;
  full_name: string | null; first_name: string | null; email: string;
}

function evidenceLines(cards: EvidenceCard[], selectedIds: string[]): string {
  if (!cards.length) return '_no evidence cards extracted_\n';
  const sel = new Set(selectedIds);
  const used = cards.filter(c => sel.has(c.id));
  const dropped = cards.filter(c => !sel.has(c.id));
  let s = '';
  if (used.length) {
    s += '**Used:**\n';
    for (const c of used) s += `- [${c.kind}] ${c.statement} ${c.source_url ? `(${c.source_url})` : ''}\n`;
  }
  if (dropped.length) {
    s += '**Dropped:**\n';
    for (const c of dropped) s += `- [${c.kind}] ${c.statement} — _${c.reject_reason ?? 'unused'}_\n`;
  }
  return s;
}

function render(i: number, r: PoolRow, out: DraftOutcome, secs: string): string {
  const head = `\n## ${i}. ${r.full_name || r.first_name || '(unknown)'} — ${r.company || '(no company)'}\n` +
    `\`${r.email}\` · domain \`${r.email.split('@')[1] ?? '?'}\` · ${secs}s\n\n`;
  if (out.kind === 'ready') {
    return head +
      `**outcome:** ready · **tier ${out.opener_tier} · score ${out.signal_score}** · cost $${out.cost_usd.toFixed(4)}` +
      (out.trace ? ` · _trace: ${out.trace}_` : '') + '\n\n' +
      `**subject:** ${out.subject}\n\n` +
      '```\n' + out.body + '\n```\n\n' +
      evidenceLines(out.evidence_cards, out.selected_evidence_ids) + '\n';
  }
  if (out.kind === 'skipped') return head + `**outcome:** skipped — ${out.reason}\n`;
  if (out.kind === 'retry') return head + `**outcome:** retry (provider issue) — ${out.reason}\n`;
  return head + `**outcome:** failed — ${out.reason}` + (out.trace ? ` · _trace: ${out.trace}_` : '') + '\n' +
    (out.evidence_cards ? evidenceLines(out.evidence_cards, []) : '') + '\n';
}

describe('cold-email end-to-end demo', () => {
  it(`generates personalized emails for ${N} random pool leads`, async () => {
    const supabase = createAdminClient();

    // The sendable frontier: leads at/after the pool pointer (email_pool_state.
    // next_sequence) are the un-consumed ones the seed route would draft next.
    // Random sampling across the whole pool mostly hits already-contacted
    // (blacklisted) rows, so pull from the frontier and filter to sendable.
    const { data: stateRow } = await supabase
      .from('email_pool_state').select('next_sequence').eq('id', 1).maybeSingle();
    const nextSeq = (stateRow as { next_sequence: number } | null)?.next_sequence ?? 0;
    const { data: frontier } = await supabase
      .from('email_pool')
      .select('id, sequence, company, full_name, first_name, email')
      .gte('sequence', nextSeq)
      .order('sequence', { ascending: true })
      .limit(500);
    const all = (frontier ?? []) as PoolRow[];
    expect(all.length).toBeGreaterThan(0);
    const emails = all.map(r => r.email.toLowerCase());
    const blocked = new Set<string>();
    for (let i = 0; i < emails.length; i += 200) {
      const slice = emails.slice(i, i + 200);
      const { data: bl } = await supabase.from('email_blacklist').select('email').in('email', slice);
      for (const r of (bl ?? []) as Array<{ email: string }>) blocked.add(r.email.toLowerCase());
      const { data: ld } = await supabase.from('leads').select('contact_email').in('contact_email', slice);
      for (const r of (ld ?? []) as Array<{ contact_email: string }>) blocked.add(r.contact_email.toLowerCase());
    }
    const sendable = all.filter(r => !blocked.has(r.email.toLowerCase()));
    for (let i = sendable.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sendable[i], sendable[j]] = [sendable[j], sendable[i]]; }
    const rows: PoolRow[] = sendable.slice(0, N);
    console.log(`[demo] candidates=${all.length} blocked=${blocked.size} sendable=${sendable.length} → using ${rows.length}`);

    console.log(`[demo] processing ${rows.length} leads (concurrency 3)`);
    const PER_LEAD_CAP_MS = 240_000;
    const blocks: string[] = new Array(rows.length).fill('');

    async function runOne(myIdx: number): Promise<void> {
      const r = rows[myIdx];
      const input: DraftInput = {
        id: `demo-${myIdx + 1}`, pool_id: r.id, email: r.email,
        first_name: r.first_name, full_name: r.full_name, company: r.company,
        domain: r.email.split('@')[1] ?? null,
        sender_account_id: SENDER.id, sender_name: SENDER.name, sender_email: SENDER.email,
      };
      const started = Date.now();
      let out: DraftOutcome;
      try {
        out = await Promise.race([
          processDraftRow(input, supabase),
          new Promise<DraftOutcome>(res => setTimeout(() => res({ kind: 'failed', reason: 'lead_cap_timeout', cost_usd: 0 }), PER_LEAD_CAP_MS)),
        ]);
      } catch (e) {
        out = { kind: 'failed', reason: `threw:${e instanceof Error ? e.message : String(e)}`, cost_usd: 0 };
      }
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      blocks[myIdx] = render(myIdx + 1, r, out, secs);
      console.log(`[demo] ${myIdx + 1}/${rows.length} ${r.company ?? '?'} → ${out.kind}${out.kind === 'ready' ? ` t${out.opener_tier}` : ''} (${secs}s)`);
    }

    let next = 0;
    const worker = async () => { while (next < rows.length) { const m = next++; await runOne(m); } };
    await Promise.all([worker(), worker()]); // concurrency 2 — fewer simultaneous v4-flash calls

    writeFileSync(OUT, `# Cold-email end-to-end demo\n\nModel: deepseek/deepseek-v4-flash · ${rows.length} sendable leads · sender: ${SENDER.name}\n` + blocks.join(''));
    console.log(`[demo] done → ${OUT}`);
  });
});
