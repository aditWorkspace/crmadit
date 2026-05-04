import { config } from 'dotenv';
config({ path: '.env.local' });
import { signSession, SESSION_COOKIE_NAME } from '@/lib/auth/cookie-session';
import { ACTIVE_STAGES } from '@/lib/constants';

async function main() {
  const ADIT_ID = '81e3b472-0359-4065-a626-c87b678dd556';
  const SRIJAY_ID = '819ef9cd-d35d-4926-8475-1fe1940da742';
  const token = signSession(ADIT_ID);

  const url = `https://pmcrminternal.vercel.app/api/leads?${ACTIVE_STAGES.map(s => `stage=${s}`).join('&')}&limit=1000`;
  console.log('URL:', url);
  const res = await fetch(url, {
    headers: { 'cookie': `${SESSION_COOKIE_NAME}=${token}` },
  });
  console.log('STATUS:', res.status);
  const data = await res.json() as { leads?: Array<{ owned_by: string; contact_name: string; stage: string }> };
  if (!data.leads) {
    console.log('NO LEADS KEY:', JSON.stringify(data).slice(0, 300));
    return;
  }
  const srijaysLeads = data.leads.filter(l => l.owned_by === SRIJAY_ID);
  const aditLeads = data.leads.filter(l => l.owned_by === ADIT_ID);
  console.log('Total leads returned:', data.leads.length);
  console.log('Adit-owned:', aditLeads.length);
  console.log('Srijay-owned:', srijaysLeads.length);
  if (srijaysLeads.length > 0) {
    console.log('First 3 Srijay:', srijaysLeads.slice(0, 3).map(l => `${l.contact_name} (${l.stage})`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
