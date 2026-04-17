import { createAdminClient } from '@/lib/supabase/admin';

type Client = ReturnType<typeof createAdminClient>;

export async function cancelQueuedAutoSendForLead(
  leadId: string,
  reason: string,
  client?: Client,
): Promise<number> {
  const supabase = client ?? createAdminClient();
  const { data } = await supabase
    .from('follow_up_queue')
    .update({ status: 'dismissed', dismissed_at: new Date().toISOString(), reason })
    .eq('lead_id', leadId)
    .eq('auto_send', true)
    .eq('status', 'pending')
    .select('id');
  return data?.length ?? 0;
}
