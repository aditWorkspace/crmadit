// Server component for /email-tool/admin. Gates on admin session, hydrates
// the client with the founder's identity. The client handles tab routing
// via ?tab= and fetches data per tab.

import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/auth/cookie-session';
import { createAdminClient } from '@/lib/supabase/admin';
import AdminClient from './admin-client';

export const dynamic = 'force-dynamic';

export default async function EmailToolAdminPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const payload = verifySession(token);
  if (!payload) redirect('/');

  const supabase = createAdminClient();
  const { data: member } = await supabase
    .from('team_members')
    .select('id, name, is_admin')
    .eq('id', payload.tm)
    .single();
  if (!member) redirect('/');
  if (!member.is_admin) redirect('/email-tool');

  return (
    <Suspense fallback={null}>
      <AdminClient memberName={member.name} />
    </Suspense>
  );
}
