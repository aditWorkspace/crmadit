import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await req.formData();
  const leadId = formData.get('lead_id') as string;
  const sourceType = formData.get('source_type') as 'txt_upload' | 'granola_link' | 'paste';
  const rawText = formData.get('raw_text') as string | null;
  const granolaUrl = formData.get('granola_url') as string | null;
  const file = formData.get('file') as File | null;

  if (!leadId) return NextResponse.json({ error: 'lead_id required' }, { status: 400 });

  const supabase = createAdminClient();
  let filePath: string | null = null;
  let transcriptText = rawText;

  // Upload file to Supabase Storage if provided
  if (file && sourceType === 'txt_upload') {
    const buffer = await file.arrayBuffer();
    const path = `transcripts/${leadId}/${Date.now()}-${file.name}`;
    const { error: uploadError } = await supabase.storage
      .from('transcripts')
      .upload(path, buffer, { contentType: 'text/plain' });

    if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });
    filePath = path;

    // Read file content as text
    const text = new TextDecoder().decode(buffer);
    transcriptText = text;
  }

  if (!transcriptText?.trim()) {
    return NextResponse.json({ error: 'No transcript text provided' }, { status: 400 });
  }

  // Create transcript record
  const { data: transcript, error } = await supabase
    .from('transcripts')
    .insert({
      lead_id: leadId,
      source_type: sourceType,
      granola_url: granolaUrl,
      file_path: filePath,
      raw_text: transcriptText,
      processing_status: 'pending',
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ transcript }, { status: 201 });
}
