import { createAdminClient } from '@/lib/supabase/admin';
import type { LeadSummary, LeadFilter } from './types';
import type { LeadStage, Priority } from '@/types';

// Resolve identifiers (UUID, email, "Name @ Company", "Name", "Company")
// into definite lead IDs. Throws on ambiguous matches — that's the safety
// rail the tools rely on. The LLM may pass any of these forms; we never
// trust it to know an ID.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ResolveResult {
  resolved: ResolvedLead[];
  unresolved: UnresolvedLead[];
}
export interface ResolvedLead {
  input: string;
  id: string;
  contact_name: string;
  company_name: string;
}
export interface UnresolvedLead {
  input: string;
  reason: 'not_found' | 'ambiguous';
  candidates?: Array<{ id: string; contact_name: string; company_name: string }>;
}

export async function resolveLeadIdentifiers(inputs: string[]): Promise<ResolveResult> {
  const supabase = createAdminClient();
  const resolved: ResolvedLead[] = [];
  const unresolved: UnresolvedLead[] = [];

  for (const raw of inputs) {
    const input = raw.trim();
    if (!input) continue;

    let matches: Array<{ id: string; contact_name: string; company_name: string }> = [];

    if (UUID_RE.test(input)) {
      // Direct id lookup.
      const { data } = await supabase
        .from('leads')
        .select('id, contact_name, company_name')
        .eq('id', input)
        .limit(2);
      matches = data || [];
    } else if (EMAIL_RE.test(input)) {
      const { data } = await supabase
        .from('leads')
        .select('id, contact_name, company_name')
        .ilike('contact_email', input)
        .limit(2);
      matches = data || [];
    } else {
      // Name / company / "Name @ Company" — fuzzy. Split on " @ " or " at "
      // for combined forms; otherwise match against either field.
      const splitMatch = input.split(/\s+(?:@|at)\s+/i);
      if (splitMatch.length === 2) {
        const [nameQ, companyQ] = splitMatch;
        const { data } = await supabase
          .from('leads')
          .select('id, contact_name, company_name')
          .ilike('contact_name', `%${nameQ.trim()}%`)
          .ilike('company_name', `%${companyQ.trim()}%`)
          .limit(5);
        matches = data || [];
      } else {
        // OR across name + company
        const { data } = await supabase
          .from('leads')
          .select('id, contact_name, company_name')
          .or(`contact_name.ilike.%${input}%,company_name.ilike.%${input}%`)
          .limit(5);
        matches = data || [];
      }
    }

    if (matches.length === 0) {
      unresolved.push({ input, reason: 'not_found' });
    } else if (matches.length > 1) {
      unresolved.push({ input, reason: 'ambiguous', candidates: matches });
    } else {
      resolved.push({
        input,
        id: matches[0].id,
        contact_name: matches[0].contact_name,
        company_name: matches[0].company_name,
      });
    }
  }

  return { resolved, unresolved };
}

// Resolve a team-member input (name OR id OR email OR 'me' meaning the
// active session's team member) into a single team_member id. Throws
// on ambiguity. 'me' depends on context.
export async function resolveTeamMember(input: string, ownerSelfId?: string): Promise<{ id: string; name: string } | null> {
  if (!input) return null;
  const q = input.trim();
  if (q.toLowerCase() === 'me' || q.toLowerCase() === 'myself') {
    if (!ownerSelfId) return null;
    const supabase = createAdminClient();
    const { data } = await supabase.from('team_members').select('id, name').eq('id', ownerSelfId).maybeSingle();
    return data ? { id: data.id, name: data.name } : null;
  }
  if (UUID_RE.test(q)) {
    const supabase = createAdminClient();
    const { data } = await supabase.from('team_members').select('id, name').eq('id', q).maybeSingle();
    return data ? { id: data.id, name: data.name } : null;
  }
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('team_members')
    .select('id, name')
    .or(`name.ilike.%${q}%,email.ilike.%${q}%`)
    .limit(2);
  if (!data?.length) return null;
  if (data.length > 1) throw new Error(`Ambiguous team member "${q}" — matches ${data.map(d => d.name).join(', ')}`);
  return { id: data[0].id, name: data[0].name };
}

// Apply a LeadFilter to a Supabase query. Returns the typed query for
// chaining. Used by find_leads / count_leads / export_csv.
//
// Note: we don't use Supabase's proper typed API because it'd require a
// large generic dance for the shared filter shape; the .from('leads')
// builder accepts string-based methods just fine.
//
// Fields with array values use `.in(...)`. Time-window filters compute
// the cutoff and use gte/lte. Stale uses last_contact_at <= cutoff (or
// IS NULL — never contacted).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyLeadFilter<T = any>(
  query: T,
  filter: LeadFilter,
  options: { teamMemberByName?: Record<string, string> } = {},
): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = query;

  if (filter.stage) {
    const stages = Array.isArray(filter.stage) ? filter.stage : [filter.stage];
    q = q.in('stage', stages as LeadStage[]);
  }
  if (filter.priority) {
    const ps = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
    q = q.in('priority', ps as Priority[]);
  }
  if (filter.owner) {
    const ownerId = options.teamMemberByName?.[filter.owner.toLowerCase()] ?? filter.owner;
    q = q.eq('owned_by', ownerId);
  }
  if (filter.tag) {
    // tags is text[]; "contains" check
    q = q.contains('tags', [filter.tag]);
  }
  if (filter.name_contains) {
    q = q.or(`contact_name.ilike.%${filter.name_contains}%,company_name.ilike.%${filter.name_contains}%`);
  }
  if (filter.email) {
    q = q.eq('contact_email', filter.email);
  }
  if (filter.contacted_within_days != null) {
    const cutoff = new Date(Date.now() - filter.contacted_within_days * 86400 * 1000).toISOString();
    q = q.gte('last_contact_at', cutoff);
  }
  if (filter.stale_for_days != null) {
    const cutoff = new Date(Date.now() - filter.stale_for_days * 86400 * 1000).toISOString();
    q = q.lte('last_contact_at', cutoff);
  }
  if (filter.call_in_last_days != null) {
    const cutoff = new Date(Date.now() - filter.call_in_last_days * 86400 * 1000).toISOString();
    q = q.or(`call_scheduled_for.gte.${cutoff},call_completed_at.gte.${cutoff}`);
  }
  if (filter.call_completed_within_days != null) {
    const cutoff = new Date(Date.now() - filter.call_completed_within_days * 86400 * 1000).toISOString();
    q = q.gte('call_completed_at', cutoff);
  }
  if (filter.is_archived === false || filter.is_archived === undefined) {
    q = q.eq('is_archived', false);
  }
  return q as T;
}

// Map team member name -> id. Cached per request, cheap.
export async function teamMemberMap(): Promise<Record<string, string>> {
  const supabase = createAdminClient();
  const { data } = await supabase.from('team_members').select('id, name');
  const map: Record<string, string> = {};
  for (const m of data || []) map[m.name.toLowerCase()] = m.id;
  return map;
}

// Map team_member id -> name (display).
export async function teamMemberNames(): Promise<Record<string, string>> {
  const supabase = createAdminClient();
  const { data } = await supabase.from('team_members').select('id, name');
  const map: Record<string, string> = {};
  for (const m of data || []) map[m.id] = m.name;
  return map;
}

// Convenience: turn a raw row into a LeadSummary using a names lookup.
export function toLeadSummary(row: Record<string, unknown>, names: Record<string, string>): LeadSummary {
  return {
    id: row.id as string,
    contact_name: (row.contact_name as string) || 'Unknown',
    contact_email: (row.contact_email as string) || '',
    company_name: (row.company_name as string) || 'Unknown',
    stage: row.stage as LeadStage,
    priority: row.priority as Priority,
    owned_by_name: row.owned_by ? names[row.owned_by as string] : undefined,
    last_contact_at: row.last_contact_at as string | undefined,
    call_scheduled_for: row.call_scheduled_for as string | undefined,
    tags: (row.tags as string[]) || [],
    heat_score: row.heat_score as number | undefined,
  };
}
