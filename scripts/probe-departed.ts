import { config } from 'dotenv';
config({ path: '.env.local' });
import { signSession, SESSION_COOKIE_NAME } from '@/lib/auth/cookie-session';

async function main() {
  const ADIT_ID = '81e3b472-0359-4065-a626-c87b678dd556';
  const token = signSession(ADIT_ID);
  const res = await fetch('https://pmcrminternal.vercel.app/api/team/departed', {
    headers: { 'cookie': `${SESSION_COOKIE_NAME}=${token}` },
  });
  console.log('STATUS:', res.status);
  console.log('BODY:', await res.text());
}

main().catch(e => { console.error(e); process.exit(1); });
