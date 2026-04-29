// Header-based auto-reply / bounce / system-mail detector.
//
// The user's policy: a real reply from a prospect creates a CRM lead.
// A vacation responder, mailer-daemon bounce, mailing-list confirmation, or
// any other automated response does NOT.
//
// Subject-prefix detection (matcher.ts → isBounceEmail) catches obvious
// human-readable cues like "Out of Office:" or "Automatic Reply:". This
// module covers the cases where the subject looks like a normal reply
// ("Re: product prioritization at Acme") but the underlying message is
// machine-generated. We rely on RFC-3834 / de-facto headers that real human
// replies essentially never set.
//
// Returns an opaque verdict: caller decides what to do with auto-replies
// (drop, audit-log, mark queue row, etc.). This module does not touch the
// database.
//
// References:
//   - RFC 3834 (Recommendations for Automatic Responses to Electronic Mail)
//   - https://datatracker.ietf.org/doc/html/rfc3834#section-2

export type AutoReplyReason =
  | 'auto_submitted'      // RFC 3834 Auto-Submitted: anything-but-no
  | 'x_autoreply'         // X-Autoreply / X-Autorespond / X-Autoresponder presence
  | 'precedence_bulk'     // Precedence: bulk | auto_reply | junk | list
  | 'empty_return_path'   // Return-Path: <> (bounce indicator)
  | 'system_from';        // From local-part is a known system mailbox

export type AutoReplyVerdict =
  | { isAutoReply: false }
  | { isAutoReply: true; reason: AutoReplyReason; detail?: string };

const SYSTEM_FROM_LOCALPARTS = new Set([
  'mailer-daemon',
  'postmaster',
  'noreply',
  'no-reply',
  'do-not-reply',
  'donotreply',
  'bounces',
  'notifications',
  'notification',
  'alerts',
  'auto-reply',
  'autoreply',
]);

interface RawHeader {
  name?: string | null;
  value?: string | null;
}

export function detectAutoReply(rawHeaders: RawHeader[] | null | undefined): AutoReplyVerdict {
  if (!rawHeaders || rawHeaders.length === 0) return { isAutoReply: false };

  const get = (name: string): string => {
    const h = rawHeaders.find(h => h.name?.toLowerCase() === name.toLowerCase());
    return (h?.value ?? '').trim();
  };

  // 1. Auto-Submitted (RFC 3834). The standard says regular conversation
  //    traffic SHOULD set "Auto-Submitted: no" or omit it. Anything else —
  //    "auto-replied", "auto-generated", "auto-notified" — means the
  //    sender's MTA / responder generated it automatically.
  const autoSubmitted = get('Auto-Submitted').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') {
    return { isAutoReply: true, reason: 'auto_submitted', detail: autoSubmitted };
  }

  // 2. X-Autoreply / X-Autorespond / X-Autoresponder. Older systems and
  //    Outlook still use these. Presence (any value) is the signal.
  if (get('X-Autoreply') || get('X-Autorespond') || get('X-Autoresponder')) {
    return { isAutoReply: true, reason: 'x_autoreply' };
  }

  // 3. Precedence header. Real personal replies don't set this — it's used
  //    by autoresponders, mailing lists, and bulk senders. Block if value is
  //    one of: bulk, auto_reply, junk, list.
  const precedence = get('Precedence').toLowerCase();
  if (
    precedence === 'bulk' ||
    precedence === 'auto_reply' ||
    precedence === 'junk' ||
    precedence === 'list'
  ) {
    return { isAutoReply: true, reason: 'precedence_bulk', detail: precedence };
  }

  // 4. Return-Path: <> is the canonical bounce-message indicator (per
  //    RFC 5321 §4.5.5 — null reverse-path on DSNs / NDRs).
  const returnPath = get('Return-Path');
  if (returnPath === '<>') {
    return { isAutoReply: true, reason: 'empty_return_path' };
  }

  // 5. From-address local-part against a known-system blocklist. Catches
  //    notifications systems that sometimes don't bother with Auto-Submitted.
  const fromHeader = get('From').toLowerCase();
  const fromEmail = extractEmail(fromHeader);
  const localPart = fromEmail.split('@')[0] ?? '';
  if (SYSTEM_FROM_LOCALPARTS.has(localPart)) {
    return { isAutoReply: true, reason: 'system_from', detail: fromEmail };
  }

  return { isAutoReply: false };
}

function extractEmail(headerValue: string): string {
  const m = headerValue.match(/<([^>]+)>/);
  return (m ? m[1] : headerValue).trim();
}
