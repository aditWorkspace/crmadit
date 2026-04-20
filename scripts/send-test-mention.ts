import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(url, key);

async function main() {
  const { data: members, error } = await supabase
    .from('team_members')
    .select('id, name, email');
  if (error) throw error;

  const adit = members!.find((m) => m.name === 'Adit');
  const srijay = members!.find((m) => m.name === 'Srijay');
  if (!adit || !srijay) throw new Error('missing team members');

  const body =
    '@Adit heads up — Shian from Notion sent a calendar link, can you log in and book them?';

  const res = await fetch('http://localhost:3000/api/threads/test-mention-001/comments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-team-member-id': srijay.id,
    },
    body: JSON.stringify({ body, mentioned_ids: [adit.id] }),
  });

  const json = await res.json();
  console.log('status:', res.status);
  console.log('response:', JSON.stringify(json, null, 2));
  console.log('\nauthor (Srijay):', srijay.id);
  console.log('mentioned (Adit):', adit.id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
