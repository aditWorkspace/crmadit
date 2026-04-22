export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyCronAuth } from '@/lib/auth/cron';
import { processAndApplyTranscript } from '@/lib/automation/process-and-apply-transcript';

const MAX_PER_RUN = 5;
const STUCK_THRESHOLD_MINUTES = 2;

export async function POST(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const stuckThreshold = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const { data: stuck, error } = await supabase
    .from('transcripts')
    .select('id')
    .in('processing_status', ['pending', 'processing'])
    .lt('created_at', stuckThreshold)
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!stuck?.length) {
    return NextResponse.json({ status: 'done', processed: 0 });
  }

  const results = await Promise.allSettled(
    stuck.map(t => processAndApplyTranscript(t.id))
  );

  const succeeded = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;

  return NextResponse.json({ status: 'done', processed: stuck.length, succeeded, failed });
}

export const GET = POST;
