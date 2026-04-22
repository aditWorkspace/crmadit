/**
 * Multi-Stage Auto-Reply Pipeline
 *
 * Orchestrates the 5-stage bulletproof auto-reply system:
 * 1. Deterministic pre-filter (no AI) - instant skip for OOO, unsubscribe, etc.
 * 2. AI Classifier (Haiku) - 40+ categories with multi-category support
 * 3. AI Edge Case Detector (DeepSeek) - scoring rubric with 7.0/10 threshold
 * 4. AI Writer (Haiku) - addresses all categories and embedded questions
 * 5. Queue for 30-60 min delay with human-reply cancellation
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { preFilter, type PreFilterInput } from './auto-reply-prefilter';
import { classifyReply, type ClassifierResult } from '@/lib/ai/reply-classifier';
import { detectEdgeCases, type EdgeDetectorResult } from '@/lib/ai/edge-case-detector';
import { writeReply, type WriterResult } from '@/lib/ai/reply-writer';
import { formatEmailBody } from '@/lib/format/email-body';
import { isWithinSendingWindow, pickRandomSendTime } from './send-guards';
import { autoReplyEnabled } from './kill-switch';

const MAX_LEADS_PER_RUN = 25;
const MAX_INBOUND_AGE_HOURS = 168; // 7 days

export interface PipelineResult {
  processed: number;
  queued: number;
  skipped: number;
  founder: number;
  errors: string[];
  details?: PipelineDetail[];
}

export interface PipelineDetail {
  lead_id: string;
  stage: 'prefilter' | 'classifier' | 'edge_detector' | 'writer' | 'queued';
  action: 'queued' | 'skipped' | 'founder' | 'error';
  reason: string;
  classifier_result?: ClassifierResult;
  edge_detector_result?: EdgeDetectorResult;
  writer_result?: WriterResult;
  message_preview?: string;
}

export interface RunOptions {
  dryRun?: boolean;
}

function firstNameOf(fullName: string | null | undefined): string {
  if (!fullName) return 'Adit';
  const trimmed = fullName.trim();
  if (!trimmed) return 'Adit';
  return trimmed.split(/\s+/)[0];
}

function buildThreadContext(
  interactions: Array<{ type: string; body: string | null }>,
  contactName: string
): string {
  return interactions
    .slice(0, 6)
    .map(i => {
      const role = i.type === 'email_inbound' ? contactName : 'Us';
      return `[${role}]: ${(i.body || '').slice(0, 300)}`;
    })
    .join('\n\n');
}

export async function runAutoReplyPipeline(
  opts: RunOptions = {}
): Promise<PipelineResult> {
  const { dryRun = false } = opts;
  const result: PipelineResult = {
    processed: 0,
    queued: 0,
    skipped: 0,
    founder: 0,
    errors: [],
    details: dryRun ? [] : undefined,
  };

  if (!autoReplyEnabled()) return result;

  const supabase = createAdminClient();

  // Find candidates: leads in 'replied' stage that haven't been auto-replied to
  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('id, contact_name, contact_email, contact_role, company_name, owned_by, stage')
    .eq('stage', 'replied')
    .eq('auto_replied_to_first', false)
    .eq('is_archived', false)
    .not('owned_by', 'is', null)
    .not('contact_email', 'is', null)
    .limit(MAX_LEADS_PER_RUN);

  if (leadsError) {
    result.errors.push(`leads query failed: ${leadsError.message}`);
    return result;
  }
  if (!leads || leads.length === 0) return result;

  for (const lead of leads) {
    result.processed++;

    try {
      // Atomic lock: prevent concurrent processing
      if (!dryRun) {
        const { data: locked, error: lockError } = await supabase
          .from('leads')
          .update({ auto_replied_to_first: true })
          .eq('id', lead.id)
          .eq('auto_replied_to_first', false)
          .select('id');
        if (lockError || !locked || locked.length === 0) {
          result.skipped++;
          continue;
        }
      }

      // Fetch recent thread context
      const { data: interactions } = await supabase
        .from('interactions')
        .select('id, type, subject, body, gmail_message_id, gmail_thread_id, metadata, occurred_at')
        .eq('lead_id', lead.id)
        .in('type', ['email_inbound', 'email_outbound'])
        .order('occurred_at', { ascending: false })
        .limit(10);

      if (!interactions || interactions.length === 0) {
        await rollbackLock(supabase, lead.id, dryRun);
        result.skipped++;
        recordDetail(result, lead.id, 'prefilter', 'skipped', 'no thread history');
        continue;
      }

      const lastInteraction = interactions[0];
      if (lastInteraction.type !== 'email_inbound') {
        await rollbackLock(supabase, lead.id, dryRun);
        result.skipped++;
        recordDetail(result, lead.id, 'prefilter', 'skipped', 'last interaction not inbound');
        continue;
      }

      const threadId = lastInteraction.gmail_thread_id;
      if (!threadId) {
        await rollbackLock(supabase, lead.id, dryRun);
        result.skipped++;
        recordDetail(result, lead.id, 'prefilter', 'skipped', 'missing gmail_thread_id');
        continue;
      }

      // Fetch owner for Gmail send
      const { data: owner } = await supabase
        .from('team_members')
        .select('id, name, email, gmail_connected')
        .eq('id', lead.owned_by)
        .single();

      if (!owner) {
        await rollbackLock(supabase, lead.id, dryRun);
        result.skipped++;
        recordDetail(result, lead.id, 'prefilter', 'skipped', 'owner not found');
        continue;
      }

      const inboundTime = new Date(lastInteraction.occurred_at);
      const inboundAgeHours = (Date.now() - inboundTime.getTime()) / (1000 * 60 * 60);

      // ═══════════════════════════════════════════════════════════════════════
      // STAGE 1: DETERMINISTIC PRE-FILTER
      // ═══════════════════════════════════════════════════════════════════════
      const preFilterResult = preFilter({
        subject: lastInteraction.subject || '',
        body: lastInteraction.body || '',
        inboundTime,
        inboundAgeHours,
        ownerGmailConnected: owner.gmail_connected,
        interactions: interactions.map(i => ({
          type: i.type,
          occurred_at: i.occurred_at,
          metadata: i.metadata as { first_reply_auto?: boolean; auto_followup?: boolean } | null,
        })),
      });

      if (preFilterResult.action === 'skip') {
        await rollbackLock(supabase, lead.id, dryRun);
        result.skipped++;
        recordDetail(result, lead.id, 'prefilter', 'skipped', preFilterResult.reason);

        // If OOO with return date, schedule recontact
        if (preFilterResult.scheduleDate && !dryRun) {
          await supabase.from('follow_up_queue').insert({
            lead_id: lead.id,
            assigned_to: lead.owned_by,
            type: 'scheduled_recontact',
            status: 'pending',
            auto_send: false,
            scheduled_for: `${preFilterResult.scheduleDate}T10:00:00Z`,
            due_at: `${preFilterResult.scheduleDate}T10:00:00Z`,
            reason: `ooo_recontact: ${preFilterResult.reason}`,
            gmail_thread_id: threadId,
          });
        }
        continue;
      }

      if (preFilterResult.action === 'founder') {
        result.founder++;
        recordDetail(result, lead.id, 'prefilter', 'founder', preFilterResult.reason);
        if (!dryRun) {
          await createFounderReview(supabase, lead.id, lead.owned_by, threadId, preFilterResult.reason);
        }
        continue;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STAGE 2: AI CLASSIFIER
      // ═══════════════════════════════════════════════════════════════════════
      const threadContext = buildThreadContext([...interactions].reverse(), lead.contact_name);

      let classifierResult: ClassifierResult;
      try {
        classifierResult = await classifyReply({
          contactName: lead.contact_name,
          companyName: lead.company_name,
          latestInboundSubject: lastInteraction.subject || '',
          latestInboundBody: lastInteraction.body || '',
          threadContext,
        });
      } catch (err) {
        result.founder++;
        recordDetail(result, lead.id, 'classifier', 'founder', `classifier_error: ${err}`);
        if (!dryRun) {
          await createFounderReview(supabase, lead.id, lead.owned_by, threadId, 'classifier_error');
        }
        continue;
      }

      // If classifier returns edge_case primary, route to founder
      if (classifierResult.primary_category.startsWith('edge_')) {
        result.founder++;
        recordDetail(result, lead.id, 'classifier', 'founder', `edge_case: ${classifierResult.primary_category}`, classifierResult);
        if (!dryRun) {
          await createFounderReview(
            supabase, lead.id, lead.owned_by, threadId,
            `${classifierResult.primary_category}: ${classifierResult.sub_category}`
          );
        }
        continue;
      }

      // Low confidence = founder
      if (classifierResult.confidence < 0.7) {
        result.founder++;
        recordDetail(result, lead.id, 'classifier', 'founder', `low_confidence: ${classifierResult.confidence}`, classifierResult);
        if (!dryRun) {
          await createFounderReview(supabase, lead.id, lead.owned_by, threadId, `low_confidence_${classifierResult.confidence.toFixed(2)}`);
        }
        continue;
      }

      // Decline categories = skip (no response needed)
      if (classifierResult.primary_category.startsWith('decline')) {
        result.skipped++;
        recordDetail(result, lead.id, 'classifier', 'skipped', `decline: ${classifierResult.primary_category}`, classifierResult);
        continue;
      }

      // Referral = founder (need to extract contact info)
      if (classifierResult.primary_category.startsWith('referral')) {
        result.founder++;
        const refInfo = classifierResult.extracted.referral_name
          ? `referral to ${classifierResult.extracted.referral_name}`
          : 'referral (no name extracted)';
        recordDetail(result, lead.id, 'classifier', 'founder', refInfo, classifierResult);
        if (!dryRun) {
          await createFounderReview(supabase, lead.id, lead.owned_by, threadId, refInfo);
        }
        continue;
      }

      // Question categories = founder (need real answers)
      if (classifierResult.primary_category.startsWith('question_')) {
        result.founder++;
        recordDetail(result, lead.id, 'classifier', 'founder', classifierResult.primary_category, classifierResult);
        if (!dryRun) {
          await createFounderReview(supabase, lead.id, lead.owned_by, threadId, classifierResult.primary_category);
        }
        continue;
      }

      // Calendly sent = founder (need to book on their link)
      if (classifierResult.primary_category === 'calendly_sent') {
        result.founder++;
        recordDetail(result, lead.id, 'classifier', 'founder', 'calendly_sent', classifierResult);
        if (!dryRun) {
          await createFounderReview(supabase, lead.id, lead.owned_by, threadId, 'prospect_sent_calendly');
        }
        continue;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STAGE 3: AI EDGE CASE DETECTOR (paranoid safety check)
      // ═══════════════════════════════════════════════════════════════════════
      let edgeResult: EdgeDetectorResult;
      try {
        edgeResult = await detectEdgeCases({
          contactName: lead.contact_name,
          companyName: lead.company_name,
          latestInboundSubject: lastInteraction.subject || '',
          latestInboundBody: lastInteraction.body || '',
          classifierResult,
        });
      } catch (err) {
        result.founder++;
        recordDetail(result, lead.id, 'edge_detector', 'founder', `edge_detector_error: ${err}`);
        if (!dryRun) {
          await createFounderReview(supabase, lead.id, lead.owned_by, threadId, 'edge_detector_error');
        }
        continue;
      }

      // If edge detector says unsafe, route to founder
      if (!edgeResult.safe_to_auto_reply || edgeResult.recommendation !== 'send') {
        result.founder++;
        const reason = `edge_unsafe (${edgeResult.scores.weighted_total}/10): ${edgeResult.concerns.join(', ') || edgeResult.reasoning}`;
        recordDetail(result, lead.id, 'edge_detector', 'founder', reason, classifierResult, edgeResult);
        if (!dryRun) {
          await createFounderReview(supabase, lead.id, lead.owned_by, threadId, reason);
        }
        continue;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STAGE 4: AI WRITER (generate response addressing all categories)
      // ═══════════════════════════════════════════════════════════════════════
      let writerResult: WriterResult;
      try {
        writerResult = await writeReply({
          contactName: lead.contact_name,
          contactRole: lead.contact_role,
          companyName: lead.company_name,
          senderFirstName: firstNameOf(owner.name),
          latestInboundBody: lastInteraction.body || '',
          classifierResult,
        });
      } catch (err) {
        result.founder++;
        recordDetail(result, lead.id, 'writer', 'founder', `writer_error: ${err}`);
        if (!dryRun) {
          await createFounderReview(supabase, lead.id, lead.owned_by, threadId, 'writer_error');
        }
        continue;
      }

      if (!writerResult.message || writerResult.message.length < 10) {
        result.founder++;
        recordDetail(result, lead.id, 'writer', 'founder', 'writer_empty_response', classifierResult, edgeResult, writerResult);
        if (!dryRun) {
          await createFounderReview(supabase, lead.id, lead.owned_by, threadId, 'writer_empty_response');
        }
        continue;
      }

      // Format the email body with greeting + signoff
      const recipientFirstName = (lead.contact_name || '').trim().split(/\s+/)[0] || 'there';
      const formattedMessage = formatEmailBody(writerResult.message, {
        recipientFirstName,
        senderFirstName: firstNameOf(owner.name),
      });

      // ═══════════════════════════════════════════════════════════════════════
      // STAGE 5: QUEUE FOR DELAYED SEND (30-60 min)
      // ═══════════════════════════════════════════════════════════════════════
      const delayMinutes = 30 + Math.random() * 30; // 30-60 min
      let processAt: Date;

      if (isWithinSendingWindow()) {
        processAt = new Date(Date.now() + delayMinutes * 60 * 1000);
      } else {
        // Outside business hours: schedule for next window + delay
        processAt = pickRandomSendTime();
        processAt = new Date(processAt.getTime() + delayMinutes * 60 * 1000);
      }

      if (!dryRun) {
        const originalSubject = lastInteraction.subject || `product prioritization at ${lead.company_name}`;
        const threadSubject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;

        await supabase.from('auto_reply_queue').insert({
          lead_id: lead.id,
          interaction_id: lastInteraction.id,
          process_at: processAt.toISOString(),
          status: 'pending',
          classifier_result: classifierResult,
          edge_detector_result: edgeResult,
          writer_result: writerResult,
          final_message: formattedMessage,
          gmail_thread_id: threadId,
          owner_id: owner.id,
        });

        // For delay categories, also schedule a follow-up for the mentioned date
        const isDelay = classifierResult.primary_category.startsWith('delay');
        const extractedDate = classifierResult.extracted?.return_date || classifierResult.extracted?.proposed_date;
        if (isDelay && extractedDate) {
          await supabase.from('follow_up_queue').insert({
            lead_id: lead.id,
            assigned_to: lead.owned_by,
            type: 'scheduled_recontact',
            status: 'pending',
            auto_send: true, // Will check if human replied before sending
            scheduled_for: `${extractedDate}T10:00:00Z`,
            due_at: `${extractedDate}T10:00:00Z`,
            reason: `delay_recontact: ${classifierResult.primary_category}`,
            gmail_thread_id: threadId,
          });
        }
      }

      result.queued++;
      recordDetail(
        result, lead.id, 'queued', 'queued',
        `process_at: ${processAt.toISOString()}`,
        classifierResult, edgeResult, writerResult, formattedMessage
      );

    } catch (err) {
      await rollbackLock(supabase, lead.id, dryRun);
      result.errors.push(`lead ${lead.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function rollbackLock(
  supabase: ReturnType<typeof createAdminClient>,
  leadId: string,
  dryRun: boolean
): Promise<void> {
  if (dryRun) return;
  await supabase.from('leads').update({ auto_replied_to_first: false }).eq('id', leadId);
}

async function createFounderReview(
  supabase: ReturnType<typeof createAdminClient>,
  leadId: string,
  ownedBy: string,
  threadId: string,
  reason: string
): Promise<void> {
  await supabase.from('follow_up_queue').insert({
    lead_id: leadId,
    assigned_to: ownedBy,
    type: 'first_reply_manual_review',
    status: 'pending',
    due_at: new Date().toISOString(),
    reason: `NEEDS_FOUNDER: ${reason}`,
    gmail_thread_id: threadId,
  });
}

function recordDetail(
  result: PipelineResult,
  leadId: string,
  stage: PipelineDetail['stage'],
  action: PipelineDetail['action'],
  reason: string,
  classifierResult?: ClassifierResult,
  edgeResult?: EdgeDetectorResult,
  writerResult?: WriterResult,
  messagePreview?: string
): void {
  if (!result.details) return;
  result.details.push({
    lead_id: leadId,
    stage,
    action,
    reason,
    classifier_result: classifierResult,
    edge_detector_result: edgeResult,
    writer_result: writerResult,
    message_preview: messagePreview?.slice(0, 200),
  });
}
