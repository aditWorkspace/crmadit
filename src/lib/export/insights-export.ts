import { createAdminClient } from '@/lib/supabase/admin';
import type { AiActionItem, AiKeyQuote, AiPainPoint, AiProductFeedback, AiFollowUpSuggestion } from '@/types';

// Generates two markdown documents capturing every detail the founders
// have on file, formatted for fast LLM ingestion outside the CRM:
//
//   1. proxi-calls-detailed.md — one rich block per completed transcript:
//      summary, sentiment, pain points, feedback, key quotes (verbatim),
//      action items, follow-up suggestions. NOT the raw transcript.
//
//   2. proxi-themes.md — every aggregated knowledge_doc rendered into
//      one file: problem themes, problems list, product feedback list,
//      solutions list.
//
// Returns the two files as plain strings; caller is responsible for
// zipping / serving them.

interface ExportFiles {
  filename: string;
  content: string;
}

interface TranscriptForExport {
  id: string;
  created_at: string;
  ai_summary: string | null;
  ai_sentiment: string | null;
  ai_interest_level: string | null;
  ai_next_steps: string | null;
  ai_pain_points: AiPainPoint[] | null;
  ai_product_feedback: AiProductFeedback[] | null;
  ai_key_quotes: AiKeyQuote[] | null;
  ai_follow_up_suggestions: AiFollowUpSuggestion[] | null;
  ai_action_items: AiActionItem[] | null;
}

interface LeadForExport {
  id: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_role: string | null;
  company_name: string | null;
  company_url: string | null;
  company_stage: string | null;
  stage: string;
  priority: string;
  heat_score: number | null;
}

export async function buildInsightsExport(): Promise<ExportFiles[]> {
  const supabase = createAdminClient();

  // Pull transcripts joined with their lead. We exclude raw_text — the
  // user explicitly wants summaries + quotes, not the full call text.
  const { data: rows } = await supabase
    .from('transcripts')
    .select(`
      id, created_at, ai_summary, ai_sentiment, ai_interest_level,
      ai_next_steps, ai_pain_points, ai_product_feedback, ai_key_quotes,
      ai_follow_up_suggestions, ai_action_items,
      leads!inner(id, contact_name, contact_email, contact_role,
                  company_name, company_url, company_stage,
                  stage, priority, heat_score)
    `)
    .eq('processing_status', 'completed')
    .order('created_at', { ascending: false });

  // Knowledge docs (already aggregated cross-call patterns).
  const { data: docs } = await supabase
    .from('knowledge_docs')
    .select('doc_type, content, updated_at')
    .order('doc_type');

  const today = new Date().toISOString().slice(0, 10);
  const callsMd = renderCallsDoc(rows || [], today);
  const themesMd = renderThemesDoc(docs || [], today);

  return [
    { filename: 'proxi-calls-detailed.md', content: callsMd },
    { filename: 'proxi-themes-and-patterns.md', content: themesMd },
  ];
}

function renderCallsDoc(
  rows: Array<TranscriptForExport & { leads: LeadForExport | LeadForExport[] | null }>,
  today: string,
): string {
  const lines: string[] = [];
  lines.push(`# Proxi AI — Discovery Call Notes (Detailed)`);
  lines.push(``);
  lines.push(`Generated: ${today}. ${rows.length} completed call(s) on file.`);
  lines.push(``);
  lines.push(`Each section below is one prospect call. Includes AI-extracted summary,`);
  lines.push(`sentiment, pain points, product feedback, verbatim key quotes, and`);
  lines.push(`follow-up suggestions. Raw transcripts are NOT included; this is the`);
  lines.push(`structured digest meant for fast LLM consumption.`);
  lines.push(``);

  // TOC
  lines.push(`## Index`);
  lines.push(``);
  for (const r of rows) {
    const lead = pickLead(r.leads);
    const date = (r.created_at || '').slice(0, 10);
    const slug = sectionSlug(lead?.contact_name, lead?.company_name, date);
    lines.push(`- [${lead?.contact_name ?? 'Unknown'} @ ${lead?.company_name ?? 'Unknown'} (${date})](#${slug})`);
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // Body
  for (const r of rows) {
    const lead = pickLead(r.leads);
    const date = (r.created_at || '').slice(0, 10);
    const name = lead?.contact_name ?? 'Unknown';
    const company = lead?.company_name ?? 'Unknown';

    lines.push(`## ${name} @ ${company} — ${date}`);
    lines.push(``);

    // Lead metadata
    const meta: string[] = [];
    if (lead?.contact_role) meta.push(`role: ${lead.contact_role}`);
    if (lead?.contact_email) meta.push(`email: ${lead.contact_email}`);
    if (lead?.company_url) meta.push(`url: ${lead.company_url}`);
    if (lead?.company_stage) meta.push(`company stage: ${lead.company_stage}`);
    meta.push(`pipeline stage: ${lead?.stage ?? 'unknown'}`);
    meta.push(`priority: ${lead?.priority ?? 'unknown'}`);
    if (lead?.heat_score != null) meta.push(`heat score: ${lead.heat_score}`);
    if (r.ai_sentiment) meta.push(`call sentiment: ${r.ai_sentiment}`);
    if (r.ai_interest_level) meta.push(`interest level: ${r.ai_interest_level}`);
    lines.push(meta.map(m => `- **${m.split(':')[0]}**:${m.slice(m.indexOf(':') + 1)}`).join('\n'));
    lines.push(``);

    if (r.ai_summary) {
      lines.push(`### Summary`);
      lines.push(``);
      lines.push(r.ai_summary.trim());
      lines.push(``);
    }

    if (r.ai_pain_points?.length) {
      lines.push(`### Pain points (${r.ai_pain_points.length})`);
      lines.push(``);
      for (const p of r.ai_pain_points) {
        lines.push(`- **[${p.severity}]** ${p.pain_point}`);
      }
      lines.push(``);
    }

    if (r.ai_product_feedback?.length) {
      lines.push(`### Product feedback (${r.ai_product_feedback.length})`);
      lines.push(``);
      for (const f of r.ai_product_feedback) {
        lines.push(`- **[${f.category}]** ${f.feedback}`);
      }
      lines.push(``);
    }

    if (r.ai_key_quotes?.length) {
      lines.push(`### Key quotes (${r.ai_key_quotes.length})`);
      lines.push(``);
      for (const q of r.ai_key_quotes) {
        lines.push(`> "${q.quote}"`);
        lines.push(`> — **${q.speaker}** (${q.context})`);
        lines.push(``);
      }
    }

    if (r.ai_follow_up_suggestions?.length) {
      lines.push(`### Suggested follow-ups`);
      lines.push(``);
      for (const s of r.ai_follow_up_suggestions) {
        lines.push(`- **${s.action}** (${s.timing}) — ${s.reason}`);
      }
      lines.push(``);
    }

    if (r.ai_action_items?.length) {
      lines.push(`### Action items`);
      lines.push(``);
      for (const a of r.ai_action_items) {
        const assignee = a.suggested_assignee ? ` [${a.suggested_assignee}]` : '';
        const due = a.suggested_due_date ? ` (due ${a.suggested_due_date})` : '';
        lines.push(`- **[${a.urgency}]**${assignee} ${a.text}${due}`);
      }
      lines.push(``);
    }

    if (r.ai_next_steps) {
      lines.push(`### Next steps (free-form)`);
      lines.push(``);
      lines.push(r.ai_next_steps.trim());
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);
  }

  return lines.join('\n');
}

function renderThemesDoc(
  docs: Array<{ doc_type: string; content: string; updated_at: string }>,
  today: string,
): string {
  const lines: string[] = [];
  lines.push(`# Proxi AI — Aggregated Themes & Patterns`);
  lines.push(``);
  lines.push(`Generated: ${today}.`);
  lines.push(``);
  lines.push(`This is the cross-call view: aggregated problem themes, the running`);
  lines.push(`problems list, product feedback list, and solutions/ideas list.`);
  lines.push(`Each section is appended-to as new transcripts are processed.`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  const order = ['problem_themes', 'problems', 'product_feedback', 'solutions'];
  const titles: Record<string, string> = {
    problem_themes: 'Problem Themes (auto-aggregated patterns across all calls)',
    problems: 'Problems & Pain Points (per-lead entries)',
    product_feedback: 'Product Feedback (per-lead entries)',
    solutions: 'Solutions & Ideas (per-lead entries)',
  };

  for (const key of order) {
    const doc = docs.find(d => d.doc_type === key);
    if (!doc) continue;
    lines.push(`## ${titles[key] ?? key}`);
    lines.push(``);
    lines.push(`Last updated: ${doc.updated_at?.slice(0, 10) ?? 'unknown'}`);
    lines.push(``);

    if (key === 'problem_themes') {
      // Stored as JSON; render as readable markdown.
      try {
        const parsed = JSON.parse(doc.content || '{}');
        const themes = parsed.themes || [];
        if (themes.length === 0) {
          lines.push(`_No themes aggregated yet._`);
          lines.push(``);
        } else {
          for (const t of themes) {
            lines.push(`### ${t.theme} _(severity: ${t.severity}, ${t.frequency} lead${t.frequency !== 1 ? 's' : ''})_`);
            lines.push(``);
            for (const lead of (t.leads || [])) {
              lines.push(`- **${lead.name}** (${lead.company}): ${lead.pain_point}`);
            }
            lines.push(``);
          }
        }
      } catch {
        lines.push(doc.content || '');
        lines.push(``);
      }
    } else {
      lines.push(doc.content || '_(empty)_');
      lines.push(``);
    }
    lines.push(`---`);
    lines.push(``);
  }

  return lines.join('\n');
}

function pickLead<T>(leads: T | T[] | null | undefined): T | null {
  if (!leads) return null;
  return Array.isArray(leads) ? leads[0] ?? null : leads;
}

function sectionSlug(name: string | null | undefined, company: string | null | undefined, date: string): string {
  return [name, company, date]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
