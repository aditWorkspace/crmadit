import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(req: NextRequest) {
  const member = await getSessionFromRequest(req);
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ member });
}
