import { config } from 'dotenv';
config({ path: '.env.local' });
import { signSession, SESSION_COOKIE_NAME } from '@/lib/auth/cookie-session';

async function main() {
  const ADIT_ID = '81e3b472-0359-4065-a626-c87b678dd556';
  const SRIJAY_ID = '819ef9cd-d35d-4926-8475-1fe1940da742';
  const token = signSession(ADIT_ID);
  const res = await fetch('https://pmcrminternal.vercel.app/api/pipeline?filter=all', {
    headers: { 'cookie': `${SESSION_COOKIE_NAME}=${token}` },
  });
  console.log('STATUS:', res.status);
  const data = await res.json() as { leads: Array<{ owned_by: string; contact_name: string }> };
  const srijaysLeads = data.leads.filter(l => l.owned_by === SRIJAY_ID);
  console.log('Total leads in pipeline:', data.leads.length);
  console.log('Srijay-owned leads still visible:', srijaysLeads.length);
  console.log('First 3 Srijay-owned:', srijaysLeads.slice(0, 3).map(l => l.contact_name));
}

main().catch(e => { console.error(e); process.exit(1); });
