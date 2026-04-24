import { createAdminClient } from '@/lib/supabase/admin';

// The lead index is the directory of every completed transcript — one line
// each, always in context. It stops the model from overfitting to whatever
// handful of cards RAG retrieves by making the other 60+ prospects visible.
// Deliberately compact: name, company, date, stage, 1-line theme.
export async function buildLeadIndex(): Promise<string> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('transcripts')
    .select(`
      id,
      created_at,
      ai_summary,
      leads!inner(contact_name, company_name, stage)
    `)
    .eq('processing_status', 'completed')
    .order('created_at', { ascending: false });

  if (error || !data) return '(lead index unavailable)';

  const lines = data.map(t => {
    const lead = t.leads as unknown as { contact_name?: string; company_name?: string; stage?: string } | null;
    const name = lead?.contact_name || 'Unknown';
    const company = lead?.company_name || 'Unknown';
    const date = (t.created_at || '').slice(0, 10);
    const stage = lead?.stage || 'unknown';
    // One-line theme: first sentence of summary, capped.
    const summary = (t.ai_summary || '').split(/[.\n]/)[0].trim().slice(0, 110);
    return `- [id:${t.id}] ${name} @ ${company} (${date}, ${stage}): ${summary}`;
  });

  return `Every completed discovery-call transcript on file (${lines.length} total). ` +
    `Use this to check whether a prospect exists before claiming anything about them, ` +
    `and to notice what is NOT covered by retrieved cards.\n\n${lines.join('\n')}`;
}
