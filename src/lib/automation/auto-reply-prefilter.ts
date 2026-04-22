/**
 * Stage 1: Deterministic Pre-Filter (no AI)
 *
 * Hard-coded patterns that ALWAYS skip or route to founder.
 * Runs BEFORE any AI call to save cost on obvious cases.
 */

import { detectOutOfOffice } from './ooo-detector';

export interface PreFilterInput {
  subject: string;
  body: string;
  inboundTime: Date;
  inboundAgeHours: number;
  ownerGmailConnected: boolean;
  interactions: Array<{
    type: string;
    occurred_at: string;
    metadata?: { first_reply_auto?: boolean; auto_followup?: boolean } | null;
  }>;
}

export interface PreFilterResult {
  action: 'proceed' | 'skip' | 'founder';
  reason: string;
  scheduleDate?: string; // For OOO with return date
}

// Patterns that ALWAYS skip without AI
const ALWAYS_SKIP_PATTERNS: Record<string, RegExp[]> = {
  // OOO / Auto-replies (backup to ooo-detector)
  // NOTE: Only match clearly automated OOO messages, NOT conversational "I'm traveling" responses
  // "I'm traveling until X, let's connect when I'm back" is a real human reply, not OOO
  ooo: [
    /out of (the )?office/i,
    /on (annual |sick |parental )?leave/i,
    /away from (my )?email/i,
    /auto[- ]?reply/i,
    /automatic reply/i,
    /limited access to email/i,
    /will (respond|reply|get back) when i return/i,
    /currently out of the office/i,
    /^i (am|will be) out/i, // Only at start of message (formal OOO)
  ],

  // Unsubscribe / Remove
  unsubscribe: [
    /\bunsubscribe\b/i,
    /\bremove me\b/i,
    /\btake me off\b/i,
    /\bstop (emailing|contacting)\b/i,
    /\bdon'?t (contact|email) me\b/i,
    /\bopt[- ]?out\b/i,
    /\bno more emails?\b/i,
  ],

  // Bounce / Failure notices
  bounce: [
    /delivery (has )?failed/i,
    /undeliverable/i,
    /mailbox (is )?(full|unavailable)/i,
    /user (not |un)known/i,
    /no such user/i,
    /address rejected/i,
    /message not delivered/i,
    /permanent failure/i,
  ],

  // Calendar noise (not real replies)
  calendar: [
    /^accepted:/i,
    /^declined:/i,
    /^tentative:/i,
    /^invitation:/i,
    /calendar notification/i,
    /meeting (accepted|declined|updated)/i,
  ],

  // Spam / automated
  spam: [
    /click here to unsubscribe/i,
    /this is an automated message/i,
    /do not reply to this email/i,
    /noreply@/i,
    /no-reply@/i,
  ],
};

/**
 * Check if a human founder manually replied after the inbound
 */
function hasHumanReplyAfterInbound(
  interactions: PreFilterInput['interactions'],
  inboundTime: Date
): boolean {
  // Find outbound emails after the inbound time
  const outboundsAfterInbound = interactions.filter(i => {
    if (i.type !== 'email_outbound') return false;
    const occurredAt = new Date(i.occurred_at);
    return occurredAt > inboundTime;
  });

  if (outboundsAfterInbound.length === 0) return false;

  // Check if any of them are human (not auto-generated)
  return outboundsAfterInbound.some(i => {
    const meta = i.metadata;
    const isAuto = meta?.first_reply_auto || meta?.auto_followup;
    return !isAuto; // Human if NOT auto
  });
}

/**
 * Run deterministic pre-filter checks
 */
export function preFilter(opts: PreFilterInput): PreFilterResult {
  const { subject, body, inboundTime, inboundAgeHours, ownerGmailConnected, interactions } = opts;
  const combinedText = `${subject}\n${body}`;

  // 1. Pattern matching - instant skip
  for (const [category, patterns] of Object.entries(ALWAYS_SKIP_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(subject) || pattern.test(body)) {
        return { action: 'skip', reason: `pattern_${category}` };
      }
    }
  }

  // 2. OOO detection with return date extraction
  const ooo = detectOutOfOffice(subject, body);
  if (ooo.isOoo) {
    return {
      action: 'skip',
      reason: `ooo_detected:${ooo.reason}`,
      scheduleDate: ooo.returnDate || undefined,
    };
  }

  // 3. Human already replied?
  if (hasHumanReplyAfterInbound(interactions, inboundTime)) {
    return { action: 'skip', reason: 'human_already_replied' };
  }

  // 4. Too old? (>7 days)
  if (inboundAgeHours > 168) {
    return { action: 'founder', reason: 'inbound_too_old' };
  }

  // 5. Owner Gmail not connected?
  if (!ownerGmailConnected) {
    return { action: 'founder', reason: 'owner_gmail_disconnected' };
  }

  // 6. Empty or too short body (likely noise)
  const bodyTrimmed = body.trim();
  if (bodyTrimmed.length < 5) {
    return { action: 'founder', reason: 'body_too_short' };
  }

  // All checks passed
  return { action: 'proceed', reason: 'passed_prefilter' };
}
