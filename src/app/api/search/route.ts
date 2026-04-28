import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

function sanitizeSearch(s: string): string {
  return s.replace(/[,()'"]/g, '').trim();
}

type ThreadHit = {
  gmail_thread_id: string;
  latest_subject: string | null;
  contact_name: string | null;
  company_name: string | null;
};

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q = req.nextUrl.searchParams.get('q') || '';
  const includeParam = req.nextUrl.searchParams.get('include') || '';
  const includeThreads = includeParam.split(',').map((s) => s.trim()).includes('threads');

  if (q.length < 2) {
    return NextResponse.json(includeThreads ? { leads: [], threads: [] } : { leads: [] });
  }

  const safeQ = sanitizeSearch(q);
  const supabase = createAdminClient();

  // Primary search: leads' own columns.
  const { data: leadRows } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, stage, contact_email')
    .or(
      `contact_name.ilike.%${safeQ}%,company_name.ilike.%${safeQ}%,contact_email.ilike.%${safeQ}%`
    )
    .eq('is_archived', false)
    .order('last_contact_at', { ascending: false, nullsFirst: false })
    .limit(10);

  const leads = leadRows || [];

  // Secondary search: lead_contacts table — picks up leads whose primary
  // contact doesn't match but who have a CC'd / forwarded participant
  // matching the query (e.g. searching "Amru" finds the 5centsCDN lead
  // whose primary contact is rahiman@ but whose contacts table also has amru@).
  if (leads.length < 10) {
    const { data: contactHits } = await supabase
      .from('lead_contacts')
      .select('lead_id')
      .or(`name.ilike.%${safeQ}%,email.ilike.%${safeQ}%`)
      .limit(40);

    const knownIds = new Set(leads.map(l => (l as { id: string }).id));
    const extraIds = Array.from(
      new Set(((contactHits ?? []) as Array<{ lead_id: string }>).map(c => c.lead_id))
    ).filter(id => !knownIds.has(id));

    if (extraIds.length > 0) {
      const { data: extraLeads } = await supabase
        .from('leads')
        .select('id, contact_name, company_name, stage, contact_email')
        .in('id', extraIds)
        .eq('is_archived', false)
        .order('last_contact_at', { ascending: false, nullsFirst: false })
        .limit(10 - leads.length);
      for (const l of extraLeads ?? []) leads.push(l);
    }
  }

  if (!includeThreads) {
    return NextResponse.json({ leads });
  }

  // Threads: search email interactions by subject/body, group by gmail_thread_id,
  // take the most recent message per thread, then join leads for display metadata.
  const { data: interactionRows } = await supabase
    .from('interactions')
    .select('gmail_thread_id, subject, lead_id, created_at, type')
    .in('type', ['email_inbound', 'email_outbound'])
    .not('gmail_thread_id', 'is', null)
    .or(`subject.ilike.%${safeQ}%,body.ilike.%${safeQ}%`)
    .order('created_at', { ascending: false })
    .limit(80);

  const threadMap = new Map<
    string,
    { subject: string | null; lead_id: string | null }
  >();
  for (const row of interactionRows || []) {
    const tid = (row as { gmail_thread_id: string | null }).gmail_thread_id;
    if (!tid) continue;
    if (threadMap.has(tid)) continue; // keep most recent (rows are ordered desc)
    threadMap.set(tid, {
      subject: (row as { subject: string | null }).subject,
      lead_id: (row as { lead_id: string | null }).lead_id,
    });
    if (threadMap.size >= 10) break;
  }

  const leadIds = Array.from(
    new Set(
      Array.from(threadMap.values())
        .map((v) => v.lead_id)
        .filter((v): v is string => !!v)
    )
  );

  const leadMeta = new Map<
    string,
    { contact_name: string | null; company_name: string | null }
  >();
  if (leadIds.length > 0) {
    const { data: leadLookup } = await supabase
      .from('leads')
      .select('id, contact_name, company_name')
      .in('id', leadIds);
    for (const l of leadLookup || []) {
      const row = l as { id: string; contact_name: string | null; company_name: string | null };
      leadMeta.set(row.id, {
        contact_name: row.contact_name,
        company_name: row.company_name,
      });
    }
  }

  const threads: ThreadHit[] = Array.from(threadMap.entries()).map(
    ([gmail_thread_id, entry]) => {
      const meta = entry.lead_id ? leadMeta.get(entry.lead_id) : undefined;
      return {
        gmail_thread_id,
        latest_subject: entry.subject,
        contact_name: meta?.contact_name ?? null,
        company_name: meta?.company_name ?? null,
      };
    }
  );

  return NextResponse.json({ leads, threads });
}
