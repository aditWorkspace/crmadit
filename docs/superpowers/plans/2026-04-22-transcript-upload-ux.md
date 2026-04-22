# Transcript Upload UX Overhaul

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform transcript upload from a blocking modal flow to fire-and-forget with auto-apply, plus make all raw transcripts RAG-queryable in insights.

**Architecture:** Upload saves transcript immediately and returns. Background processing runs via Next.js `after()` API (stable in Next.js 15+). On completion, auto-applies results to lead (summary, action items, stage change, knowledge docs). A cron job catches any failures. Chat API includes raw transcript text in RAG context.

**Tech Stack:** Next.js 16 `after()` for background work, Supabase Realtime for notifications, existing OpenRouter/DeepSeek for AI.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/components/transcripts/upload-modal.tsx` | Modify | Simplify to upload-only, close immediately, show toast |
| `src/app/api/transcripts/upload/route.ts` | Modify | Trigger background processing via `after()` |
| `src/lib/automation/process-and-apply-transcript.ts` | Create | Unified function: AI process + auto-apply to lead |
| `src/app/api/cron/process-transcripts/route.ts` | Create | Fallback cron for stuck pending transcripts |
| `src/app/api/knowledge-docs/chat/route.ts` | Modify | Add raw transcripts to RAG context |
| `src/hooks/use-transcript-notifications.ts` | Create | Realtime subscription for transcript completion |
| `vercel.json` | Modify | Add process-transcripts cron |

---

### Task 1: Create Unified Process-and-Apply Function

**Files:**
- Create: `src/lib/automation/process-and-apply-transcript.ts`

This extracts the AI processing + apply logic into a reusable function that can be called from both the background job and the cron fallback.

- [ ] **Step 1: Create the process-and-apply function**

```typescript
// src/lib/automation/process-and-apply-transcript.ts
import { createAdminClient } from '@/lib/supabase/admin';
import { processTranscript } from '@/lib/ai/transcript-processor';
import { appendToKnowledgeDocs } from '@/lib/ai/knowledge-doc-updater';
import { changeStage } from '@/lib/automation/stage-logic';
import { addDays } from '@/lib/utils';
import { format } from 'date-fns';

export interface ProcessResult {
  success: boolean;
  transcriptId: string;
  error?: string;
}

/**
 * Process a transcript with AI and auto-apply all results to the lead.
 * This is the unified function called by both background jobs and cron fallback.
 */
export async function processAndApplyTranscript(transcriptId: string): Promise<ProcessResult> {
  const supabase = createAdminClient();

  // Get transcript
  const { data: transcript, error: fetchError } = await supabase
    .from('transcripts')
    .select('*, leads(id, contact_name, company_name, stage, owned_by)')
    .eq('id', transcriptId)
    .single();

  if (fetchError || !transcript) {
    return { success: false, transcriptId, error: 'Transcript not found' };
  }

  if (!transcript.raw_text) {
    await supabase.from('transcripts').update({ processing_status: 'failed' }).eq('id', transcriptId);
    return { success: false, transcriptId, error: 'No transcript text' };
  }

  // Mark as processing
  await supabase.from('transcripts').update({ processing_status: 'processing' }).eq('id', transcriptId);

  try {
    // AI analysis
    const analysis = await processTranscript(transcript.raw_text);

    // Save AI results to transcript
    await supabase.from('transcripts').update({
      ai_summary: analysis.summary,
      ai_next_steps: analysis.next_steps,
      ai_action_items: analysis.action_items,
      ai_sentiment: analysis.sentiment,
      ai_interest_level: analysis.interest_level,
      ai_key_quotes: analysis.key_quotes,
      ai_pain_points: analysis.pain_points,
      ai_product_feedback: analysis.product_feedback,
      ai_follow_up_suggestions: analysis.follow_up_suggestions,
      ai_contact_info_extracted: analysis.contact_info_extracted,
      processing_status: 'completed',
      processed_at: new Date().toISOString(),
    }).eq('id', transcriptId);

    // Auto-apply to lead
    const leadId = transcript.lead_id;
    const lead = transcript.leads;

    // Update lead with call summary and next steps
    await supabase.from('leads').update({
      call_summary: analysis.summary,
      next_steps: analysis.next_steps,
      updated_at: new Date().toISOString(),
    }).eq('id', leadId);

    // Insert action items
    if (analysis.action_items?.length) {
      await supabase.from('action_items').insert(
        analysis.action_items.map(item => ({
          lead_id: leadId,
          text: item.text,
          assigned_to: item.suggested_assignee || null,
          due_date: item.suggested_due_date || null,
          source: 'ai_extracted',
        }))
      );
    }

    // Create follow-ups from suggestions
    if (analysis.follow_up_suggestions?.length) {
      await supabase.from('follow_up_queue').insert(
        analysis.follow_up_suggestions.map(s => ({
          lead_id: leadId,
          assigned_to: lead?.owned_by || null,
          type: 'check_in',
          reason: s.action,
          suggested_message: s.reason,
          due_at: addDays(new Date(), 1).toISOString(),
          status: 'pending',
        }))
      );
    }

    // Auto-advance to call_completed if not already past that
    const preCallStages = ['replied', 'scheduling', 'scheduled'];
    if (lead && preCallStages.includes(lead.stage)) {
      // Use null for team_member_id since this is automated
      await changeStage(leadId, 'call_completed', null);
    }

    // Log interaction
    await supabase.from('interactions').insert({
      lead_id: leadId,
      team_member_id: null, // automated
      type: 'call',
      subject: 'Call transcript auto-processed',
      body: analysis.summary,
      occurred_at: new Date().toISOString(),
    });

    // Log activity
    await supabase.from('activity_log').insert({
      lead_id: leadId,
      team_member_id: null,
      action: 'transcript_auto_applied',
      details: {
        transcript_id: transcriptId,
        action_items_count: analysis.action_items?.length || 0,
        follow_ups_count: analysis.follow_up_suggestions?.length || 0,
      },
    });

    // Update knowledge docs
    if (lead?.contact_name && lead?.company_name) {
      try {
        await appendToKnowledgeDocs({
          leadName: lead.contact_name,
          companyName: lead.company_name,
          date: format(new Date(), 'yyyy-MM-dd'),
          painPoints: analysis.pain_points || [],
          productFeedback: analysis.product_feedback || [],
          keyQuotes: analysis.key_quotes || [],
          followUpSuggestions: analysis.follow_up_suggestions || [],
        });
      } catch (kdErr) {
        console.error('[knowledge-docs] Failed to update:', kdErr);
        // Non-fatal
      }
    }

    return { success: true, transcriptId };
  } catch (err) {
    console.error(`[process-transcript] Failed for ${transcriptId}:`, err);
    await supabase.from('transcripts').update({
      processing_status: 'failed',
    }).eq('id', transcriptId);
    return { success: false, transcriptId, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
```

- [ ] **Step 2: Verify file created correctly**

Run: `head -20 src/lib/automation/process-and-apply-transcript.ts`

- [ ] **Step 3: Commit**

```bash
git add src/lib/automation/process-and-apply-transcript.ts
git commit -m "feat: add unified process-and-apply-transcript function"
```

---

### Task 2: Modify Upload API to Trigger Background Processing

**Files:**
- Modify: `src/app/api/transcripts/upload/route.ts`

Use Next.js 15+ `after()` API to trigger background processing after response is sent.

- [ ] **Step 1: Update upload route to use after() for background processing**

Replace the entire file:

```typescript
// src/app/api/transcripts/upload/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { processAndApplyTranscript } from '@/lib/automation/process-and-apply-transcript';

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

  const VALID_SOURCE_TYPES = ['txt_upload', 'granola_link', 'paste'];
  if (!VALID_SOURCE_TYPES.includes(sourceType)) {
    return NextResponse.json({ error: 'Invalid source_type' }, { status: 400 });
  }

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
    transcriptText = new TextDecoder().decode(buffer);
  }

  if (!transcriptText?.trim()) {
    return NextResponse.json({ error: 'No transcript text provided' }, { status: 400 });
  }

  // Create transcript record with pending status
  const { data: transcript, error } = await supabase
    .from('transcripts')
    .insert({
      lead_id: leadId,
      source_type: sourceType,
      granola_url: granolaUrl,
      file_path: filePath,
      raw_text: transcriptText,
      processing_status: 'pending',
      uploaded_by: session.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Trigger background processing via Next.js after() API
  // This runs AFTER the response is sent to the client
  after(async () => {
    console.log(`[transcript-upload] Starting background processing for ${transcript.id}`);
    const result = await processAndApplyTranscript(transcript.id);
    if (result.success) {
      console.log(`[transcript-upload] Successfully processed ${transcript.id}`);
    } else {
      console.error(`[transcript-upload] Failed to process ${transcript.id}: ${result.error}`);
    }
  });

  // Return immediately - processing happens in background
  return NextResponse.json({ 
    transcript,
    processing: 'background',
    message: 'Transcript uploaded. Processing in background.',
  }, { status: 201 });
}
```

- [ ] **Step 2: Verify syntax**

Run: `npx tsc --noEmit src/app/api/transcripts/upload/route.ts 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/transcripts/upload/route.ts
git commit -m "feat: fire-and-forget transcript upload with background processing"
```

---

### Task 3: Create Cron Fallback for Stuck Transcripts

**Files:**
- Create: `src/app/api/cron/process-transcripts/route.ts`
- Modify: `vercel.json`

Cron runs every 5 minutes and picks up any transcripts stuck in 'pending' status.

- [ ] **Step 1: Create cron route**

```typescript
// src/app/api/cron/process-transcripts/route.ts
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

  // Find transcripts stuck in pending or processing for too long
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

  return NextResponse.json({
    status: 'done',
    processed: stuck.length,
    succeeded,
    failed,
  });
}

export const GET = POST;
```

- [ ] **Step 2: Update vercel.json to add cron**

Read current vercel.json and add the new cron:

```json
{
  "crons": [
    { "path": "/api/cron/daily-digest", "schedule": "0 16 * * *" },
    { "path": "/api/cron/process-transcripts", "schedule": "*/5 * * * *" }
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cron/process-transcripts/route.ts vercel.json
git commit -m "feat: add cron fallback for stuck transcript processing"
```

---

### Task 4: Simplify Upload Modal to Fire-and-Forget

**Files:**
- Modify: `src/components/transcripts/upload-modal.tsx`

Remove the processing and review steps entirely. Modal just uploads and closes with a toast.

- [ ] **Step 1: Rewrite upload modal**

```typescript
// src/components/transcripts/upload-modal.tsx
'use client';

import { useState, useRef } from 'react';
import { useSession } from '@/hooks/use-session';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Upload, FileText, Loader2, Sparkles } from '@/lib/icons';
import { cn } from '@/lib/utils';

interface UploadModalProps {
  open: boolean;
  leadId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export function TranscriptUploadModal({ open, leadId, onClose, onSuccess }: UploadModalProps) {
  const { user } = useSession();
  const [pasteText, setPasteText] = useState('');
  const [granolaUrl, setGranolaUrl] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const headers: Record<string, string> = user ? { 'x-team-member-id': user.team_member_id } : {};

  const handleUpload = async (sourceType: 'txt_upload' | 'paste' | 'granola_link', file?: File) => {
    if (!user) return;
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('lead_id', leadId);
      formData.append('source_type', sourceType);

      if (sourceType === 'txt_upload' && file) {
        formData.append('file', file);
      } else if (sourceType === 'paste' || sourceType === 'granola_link') {
        formData.append('raw_text', pasteText);
        if (granolaUrl) {
          formData.append('granola_url', granolaUrl);
          formData.append('source_type', 'granola_link');
        }
      }

      const res = await fetch('/api/transcripts/upload', {
        method: 'POST',
        headers,
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      toast.success('Transcript uploaded! AI is processing in background.', {
        description: 'Results will auto-apply to this lead when ready.',
        duration: 5000,
      });
      onSuccess?.();
      handleClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleClose = () => {
    setPasteText('');
    setGranolaUrl('');
    onClose();
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file?.type === 'text/plain' || file?.name.endsWith('.txt') || file?.name.endsWith('.md')) {
      handleUpload('txt_upload', file);
    } else {
      toast.error('Only .txt and .md files are supported');
    }
  };

  const charCount = pasteText.length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4.5 w-4.5 text-gray-500" />
            Upload Transcript
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="file">
          <TabsList className="w-full">
            <TabsTrigger value="file" className="flex-1" disabled={uploading}>
              <Upload className="h-4 w-4 mr-2" />Upload File
            </TabsTrigger>
            <TabsTrigger value="paste" className="flex-1" disabled={uploading}>
              <FileText className="h-4 w-4 mr-2" />Paste Text
            </TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="mt-4">
            <div
              className={cn(
                'border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all duration-200',
                uploading && 'pointer-events-none opacity-50',
                dragOver
                  ? 'border-blue-400 bg-blue-50/50 scale-[1.01]'
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50/30'
              )}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleFileDrop}
              onClick={() => !uploading && fileInputRef.current?.click()}
            >
              {uploading ? (
                <Loader2 className="h-8 w-8 text-blue-500 animate-spin mx-auto" />
              ) : (
                <>
                  <div className={cn(
                    'h-10 w-10 rounded-xl mx-auto mb-3 flex items-center justify-center',
                    dragOver ? 'bg-blue-100' : 'bg-gray-100'
                  )}>
                    <Upload className={cn('h-5 w-5', dragOver ? 'text-blue-500' : 'text-gray-400')} />
                  </div>
                  <p className="text-sm font-medium text-gray-700">
                    {dragOver ? 'Drop to upload' : 'Drop your transcript here'}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    Supports .txt and .md files
                  </p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                className="hidden"
                disabled={uploading}
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) handleUpload('txt_upload', file);
                }}
              />
            </div>
          </TabsContent>

          <TabsContent value="paste" className="mt-4 space-y-3">
            <div className="space-y-1">
              <Label className="text-xs text-gray-500">Granola URL (optional)</Label>
              <Input
                placeholder="https://app.granola.ai/..."
                value={granolaUrl}
                onChange={e => setGranolaUrl(e.target.value)}
                className="text-sm h-9"
                disabled={uploading}
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label>Transcript Text</Label>
                {charCount > 0 && (
                  <span className="text-xs text-gray-400">{charCount.toLocaleString()} chars</span>
                )}
              </div>
              <Textarea
                placeholder="Paste your transcript from Granola, Otter, etc..."
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                rows={12}
                className="font-mono text-xs leading-relaxed"
                disabled={uploading}
              />
            </div>

            <Button
              className="w-full"
              disabled={!pasteText.trim() || uploading}
              onClick={() => handleUpload('paste')}
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Sparkles className="h-4 w-4 mr-2" />
              )}
              {uploading ? 'Uploading...' : 'Upload & Process'}
            </Button>
          </TabsContent>
        </Tabs>

        <p className="text-xs text-gray-400 text-center mt-2">
          AI analysis runs in background. Results auto-apply to this lead.
        </p>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify syntax**

Run: `npx tsc --noEmit src/components/transcripts/upload-modal.tsx 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/components/transcripts/upload-modal.tsx
git commit -m "feat: simplify transcript modal to fire-and-forget upload"
```

---

### Task 5: Add RAG Over Raw Transcripts to Chat API

**Files:**
- Modify: `src/app/api/knowledge-docs/chat/route.ts`

Include raw transcript text in the context for RAG queries.

- [ ] **Step 1: Update chat route to include transcripts**

```typescript
// src/app/api/knowledge-docs/chat/route.ts
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionFromRequest } from '@/lib/session';
import { callAI } from '@/lib/ai/openrouter';

const SYSTEM_PROMPT = `You are an AI assistant for Proxi AI, a startup building a PM command center (product prioritization tool). You help the founding team analyze insights from their prospect discovery calls.

You have access to:
1. **Knowledge Documents** — aggregated insights from all calls:
   - Problems & Pain Points
   - Product Feedback
   - Solutions & Ideas
   - Problem Themes (AI-aggregated patterns)

2. **Raw Call Transcripts** — full text from individual discovery calls with lead/company info

Rules:
- Answer based ONLY on the provided documents and transcripts. Do not make up information.
- Cite specific prospect names, companies, and dates when available.
- If the documents don't contain relevant information, say so clearly.
- Be concise and actionable — the founders are busy.
- When asked about patterns or trends, look across multiple entries for common themes.
- When asked about a specific call or company, search the raw transcripts.`;

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { question } = await req.json();
  if (!question?.trim()) {
    return NextResponse.json({ error: 'Question is required' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Fetch knowledge docs
  const { data: docs, error: docsError } = await supabase
    .from('knowledge_docs')
    .select('doc_type, content')
    .order('doc_type');

  if (docsError) {
    return NextResponse.json({ error: docsError.message }, { status: 500 });
  }

  // Fetch recent transcripts with lead info (limit to avoid context overflow)
  const { data: transcripts, error: transcriptError } = await supabase
    .from('transcripts')
    .select(`
      id,
      raw_text,
      ai_summary,
      created_at,
      leads!inner(contact_name, company_name)
    `)
    .eq('processing_status', 'completed')
    .order('created_at', { ascending: false })
    .limit(20);

  if (transcriptError) {
    console.error('[chat] Transcript fetch error:', transcriptError);
    // Non-fatal - continue without transcripts
  }

  // Build context from knowledge docs
  const docsContext = (docs || [])
    .map(d => `=== ${d.doc_type.toUpperCase().replace('_', ' ')} ===\n${d.content}`)
    .join('\n\n');

  // Build context from transcripts (truncate each to avoid token overflow)
  const transcriptContext = (transcripts || [])
    .map(t => {
      const lead = t.leads as { contact_name: string; company_name: string } | null;
      const header = `=== TRANSCRIPT: ${lead?.contact_name || 'Unknown'} (${lead?.company_name || 'Unknown'}) - ${t.created_at?.slice(0, 10) || 'Unknown date'} ===`;
      const summary = t.ai_summary ? `Summary: ${t.ai_summary}\n\n` : '';
      // Truncate raw text to ~4000 chars per transcript
      const rawText = (t.raw_text || '').slice(0, 4000);
      return `${header}\n${summary}${rawText}`;
    })
    .join('\n\n---\n\n');

  const userMessage = `Here are the knowledge documents:

${docsContext}

---

Here are the raw call transcripts:

${transcriptContext}

---

Question: ${question}`;

  try {
    const answer = await callAI({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      maxTokens: 2000,
    });

    return NextResponse.json({ answer });
  } catch (err) {
    return NextResponse.json({
      error: 'Failed to generate answer',
      details: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify syntax**

Run: `npx tsc --noEmit src/app/api/knowledge-docs/chat/route.ts 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/knowledge-docs/chat/route.ts
git commit -m "feat: add raw transcripts to insights RAG context"
```

---

### Task 6: Add DB Column for Uploaded By Tracking

**Files:**
- Create: `supabase/migrations/013_transcript_uploaded_by.sql`

- [ ] **Step 1: Create migration**

```sql
-- Track who uploaded each transcript
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES team_members(id);
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/013_transcript_uploaded_by.sql
git commit -m "feat: add uploaded_by column to transcripts"
```

---

### Task 7: Test End-to-End Flow

- [ ] **Step 1: Run type check**

Run: `npm run build 2>&1 | tail -30`

- [ ] **Step 2: Run the migration in Supabase SQL editor**

Copy `supabase/migrations/013_transcript_uploaded_by.sql` content and run in Supabase.

- [ ] **Step 3: Deploy**

Run: `vercel --prod`

- [ ] **Step 4: Test upload flow**

1. Go to a lead page
2. Click "Upload Transcript"
3. Drop a .txt file or paste text
4. Verify modal closes immediately with toast
5. Wait ~30 seconds
6. Refresh lead page — should see call summary, action items populated

- [ ] **Step 5: Test RAG**

1. Go to /insights
2. Ask in chat: "What did [company name] say about their pain points?"
3. Verify response includes transcript content

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete transcript upload UX overhaul"
git push origin main
```

---

## Summary

| Change | Before | After |
|--------|--------|-------|
| Upload UX | Blocking modal, wait for AI, manual review | Fire-and-forget, closes immediately |
| AI Processing | Synchronous, 55s timeout | Background via `after()`, 300s cron fallback |
| Save & Apply | Manual button click required | Auto-applies when AI completes |
| RAG | Knowledge docs only | Knowledge docs + raw transcripts |
| Timeout handling | Fails silently | Cron catches stuck transcripts |
