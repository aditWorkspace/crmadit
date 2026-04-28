import { createAdminClient } from '@/lib/supabase/admin';

// The lead index is the directory of every completed transcript — one line
// each, always in context. It stops the model from overfitting to whatever
// handful of cards RAG retrieves by making the other 60+ prospects visible.
//
// Two sections: customer calls (lead_id present) and advisor / misc calls
// (lead_id null, participant_name + participant_context populated). The
// model needs to know both exist when answering questions like "what did
// the advisor say about X" so the retrieved cards aren't its only context.
export async function buildLeadIndex(): Promise<string> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('transcripts')
    .select(`
      id,
      kind,
      participant_name,
      participant_context,
      created_at,
      ai_summary,
      leads(contact_name, company_name, stage)
    `)
    .eq('processing_status', 'completed')
    .order('created_at', { ascending: false });

  if (error || !data) return '(lead index unavailable)';

  const customerLines: string[] = [];
  const advisorLines: string[] = [];

  for (const t of data) {
    const date = (t.created_at || '').slice(0, 10);
    const summary = (t.ai_summary || '').split(/[.\n]/)[0].trim().slice(0, 110);
    const lead = t.leads as unknown as { contact_name?: string; company_name?: string; stage?: string } | null;

    if (lead?.contact_name || lead?.company_name) {
      const name = lead?.contact_name || 'Unknown';
      const company = lead?.company_name || 'Unknown';
      const stage = lead?.stage || 'unknown';
      customerLines.push(`- [id:${t.id}] ${name} @ ${company} (${date}, ${stage}): ${summary}`);
    } else {
      const tag = t.kind === 'misc' ? 'MISC' : 'ADVISOR';
      const who = t.participant_name || 'Unknown';
      const ctx = t.participant_context ? ` — ${t.participant_context}` : '';
      advisorLines.push(`- [id:${t.id}] [${tag}] ${who}${ctx} (${date}): ${summary}`);
    }
  }

  const sections: string[] = [];
  sections.push(
    `Every completed transcript on file (${data.length} total — ${customerLines.length} customer calls, ${advisorLines.length} advisor/misc).`,
    `Use this to check whether a person exists before claiming anything about them, and to notice what is NOT covered by retrieved cards.`,
    ``,
    `## Customer calls`,
    ``,
    customerLines.join('\n') || '(none)',
  );

  if (advisorLines.length) {
    sections.push(``, `## Advisor / misc calls`, ``, advisorLines.join('\n'));
  }

  return sections.join('\n');
}
