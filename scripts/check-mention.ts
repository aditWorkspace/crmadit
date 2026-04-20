import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const { data } = await supabase
    .from('mention_notifications')
    .select('id, recipient_id, comment_id, gmail_thread_id, read_at, created_at')
    .eq('gmail_thread_id', 'test-mention-001')
    .order('created_at', { ascending: false });

  console.log('mention_notifications rows:', JSON.stringify(data, null, 2));
}
main();
