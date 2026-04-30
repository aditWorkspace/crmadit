// Generate a valid session cookie for Adit, then call prod /api/pipeline
// to see the actual server-side error.

import { config } from 'dotenv';
config({ path: '.env.local' });

import { signSession, SESSION_COOKIE_NAME } from '@/lib/auth/cookie-session';

const ADIT_ID = '81e3b472-0359-4065-a626-c87b678dd556';

async function main() {
  const token = signSession(ADIT_ID);
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;
  console.log('cookie length:', cookie.length);

  const res = await fetch('https://pmcrminternal.vercel.app/api/pipeline?filter=all', {
    headers: { 'cookie': cookie },
  });
  console.log('STATUS:', res.status);
  const text = await res.text();
  console.log('BODY:', text.slice(0, 2000));
}

main().catch(e => { console.error(e); process.exit(1); });
