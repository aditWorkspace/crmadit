import { createAdminClient } from '@/lib/supabase/admin';
import type { TranscriptRow } from './types';

// Retrieve top-K transcript rows by Postgres full-text search.
// Search terms come from the router; we OR them into a single tsquery
// with prefix matching so "slack" matches "slacked", etc.
//
// LEFT JOIN on leads (not !inner) so advisor / misc transcripts (lead_id
// null) come back too — they have participant_name/context instead and
// the chat needs them for queries like "what did the advisor say about X?".
export async function retrieveTranscripts(
  searchTerms: string[],
  limit = 8,
): Promise<TranscriptRow[]> {
  const cleaned = searchTerms
    .map(t => t.replace(/[^\w\s]/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 8);

  if (!cleaned.length) return recentTranscripts(limit);

  const query = cleaned
    .map(term => term.split(/\s+/).filter(Boolean).map(w => `${w}:*`).join(' & '))
    .map(clause => `(${clause})`)
    .join(' | ');

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('transcripts')
    .select(SELECT_FIELDS)
    .eq('processing_status', 'completed')
    .textSearch('fts', query, { config: 'english' })
    .limit(limit);

  if (error || !data?.length) return recentTranscripts(limit);
  return flattenRows(data as unknown as RawRow[]);
}

async function recentTranscripts(limit: number): Promise<TranscriptRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('transcripts')
    .select(SELECT_FIELDS)
    .eq('processing_status', 'completed')
    .order('created_at', { ascending: false })
    .limit(limit);
  return flattenRows((data || []) as unknown as RawRow[]);
}

const SELECT_FIELDS = `
  id, lead_id, kind, participant_name, participant_context, created_at,
  raw_text, ai_summary, ai_sentiment, ai_interest_level, ai_next_steps,
  ai_pain_points, ai_product_feedback, ai_key_quotes, ai_follow_up_suggestions,
  leads(contact_name, company_name, stage)
`;

type RawRow = Omit<TranscriptRow, 'lead_contact_name' | 'lead_company_name' | 'lead_stage'> & {
  leads?: { contact_name?: string; company_name?: string; stage?: string } | null;
};

function flattenRows(rows: RawRow[]): TranscriptRow[] {
  return rows.map(r => {
    const lead = r.leads as unknown as { contact_name?: string; company_name?: string; stage?: string } | null;
    const { leads: _leads, ...rest } = r;
    void _leads;
    return {
      ...rest,
      lead_contact_name: lead?.contact_name ?? null,
      lead_company_name: lead?.company_name ?? null,
      lead_stage: lead?.stage ?? null,
    };
  });
}
