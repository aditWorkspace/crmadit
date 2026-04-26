import { createAdminClient } from '@/lib/supabase/admin';
import type { LeadSummary } from './types';

// Build a CSV string from rows. Handles RFC 4180 quoting (double quotes,
// embedded commas, embedded newlines).
export function buildCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (!rows.length) return columns?.join(',') ?? '';
  const cols = columns ?? Object.keys(rows[0]);
  const header = cols.map(escapeCsv).join(',');
  const body = rows
    .map(row => cols.map(c => escapeCsv(formatCell(row[c]))).join(','))
    .join('\n');
  return `${header}\n${body}`;
}

function formatCell(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join('|');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function escapeCsv(s: string): string {
  if (s == null) return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Upload a CSV to the existing `transcripts` bucket under exports/, return
// a signed URL that's valid for an hour. We reuse that bucket because it's
// already provisioned; CRMs are small so naming hygiene isn't critical here.
export async function uploadCsv(content: string, filename: string): Promise<{ url: string; path: string }> {
  const supabase = createAdminClient();
  const path = `exports/${Date.now()}-${filename}`;
  const buf = new TextEncoder().encode(content);
  const { error: uploadErr } = await supabase.storage
    .from('transcripts')
    .upload(path, buf, { contentType: 'text/csv', upsert: false });
  if (uploadErr) throw new Error(`csv upload failed: ${uploadErr.message}`);
  const { data: signed, error: signedErr } = await supabase.storage
    .from('transcripts')
    .createSignedUrl(path, 3600);
  if (signedErr || !signed) throw new Error(`csv sign url failed: ${signedErr?.message ?? 'unknown'}`);
  return { url: signed.signedUrl, path };
}

// Default columns for a lead-list CSV. Stable order; matches what the
// founders typically want when grabbing prospects for outreach.
export const DEFAULT_LEAD_CSV_COLUMNS = [
  'contact_name',
  'contact_email',
  'company_name',
  'stage',
  'priority',
  'owned_by_name',
  'last_contact_at',
  'call_scheduled_for',
  'tags',
  'heat_score',
];

export function leadsToCsv(leads: LeadSummary[], columns: string[] = DEFAULT_LEAD_CSV_COLUMNS): string {
  return buildCsv(leads as unknown as Array<Record<string, unknown>>, columns);
}
