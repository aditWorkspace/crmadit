import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { changeStage } from '@/lib/automation/stage-logic';
import { STAGE_ORDER } from '@/lib/constants';
import { LeadStage } from '@/types';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const { stage } = await req.json();
  if (!STAGE_ORDER.includes(stage as LeadStage)) {
    return NextResponse.json({ error: 'Invalid stage' }, { status: 400 });
  }

  const result = await changeStage(id, stage as LeadStage, session.id);
  if (!result.success) {
    return NextResponse.json({ error: result.error, code: 'VALIDATION_FAILED' }, { status: 422 });
  }

  return NextResponse.json({ success: true, stage });
}
