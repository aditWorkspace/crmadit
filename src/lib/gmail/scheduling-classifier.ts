import { callAI } from '@/lib/ai/openrouter';
import { TRIAGE_MODEL } from '@/lib/constants';

export type SchedulingSignal = 'no_signal' | 'scheduling_intent' | 'booking_confirmed';

// ── Regex patterns (instant, zero cost) ─────────────────────────────────────

const BOOKING_CONFIRMED_PATTERNS = [
  /calendly\.com\/events\//i,
  /\bhas been (scheduled|confirmed|booked)\b/i,
  /\bbooking confirmed\b/i,
  /\bevent scheduled for\b/i,
  /\bmeeting confirmed\b/i,
  /\bappointment confirmed\b/i,
  /^Invitation:/i,                            // Google Calendar invitation subject
  /^Accepted:/i,                              // Google Calendar accepted
  /You and .+ are scheduled/i,                // Calendly confirmation
  /\bA new event has been created\b/i,        // Calendly notification
  /\bconfirmed your .*(meeting|call|session)\b/i,
];

const SCHEDULING_INTENT_PATTERNS = [
  /calendly\.com\//i,
  /cal\.com\//i,
  /savvycal\.com\//i,
  /\bbook a (time|call|meeting|slot)\b/i,
  /\bschedule a (call|meeting|chat|time)\b/i,
  /\bpick a (slot|time)\b/i,
  /\bwhen works for you\b/i,
  /\bhere'?s my calendar\b/i,
  /\bbooking link\b/i,
  /\bschedule.*link\b/i,
  /\bfind a time\b/i,
  /\bgrab a time\b/i,
  /\blet'?s (set up|schedule|book)\b/i,
  /\bavailability\b.*\b(link|here|below)\b/i,
  /\bhttps?:\/\/[^\s]*\b(book|schedule|calendar|meeting)\b[^\s]*/i,
];

/**
 * Classify whether an email contains scheduling signals.
 * Uses fast regex matching first; falls back to AI only for ambiguous longer emails.
 */
export async function classifySchedulingIntent(
  subject: string,
  body: string
): Promise<SchedulingSignal> {
  const combined = `${subject} ${body}`;

  // Tier 1: Regex (instant)
  for (const pattern of BOOKING_CONFIRMED_PATTERNS) {
    if (pattern.test(subject) || pattern.test(body)) {
      return 'booking_confirmed';
    }
  }

  for (const pattern of SCHEDULING_INTENT_PATTERNS) {
    if (pattern.test(subject) || pattern.test(body)) {
      return 'scheduling_intent';
    }
  }

  // Tier 2: AI classification for longer emails that might contain subtle signals
  if (combined.length < 50) return 'no_signal';

  try {
    const response = await callAI({
      model: TRIAGE_MODEL,
      systemPrompt: 'You classify emails about meeting scheduling. Respond with exactly ONE word: "confirmed" if a meeting/call is confirmed or booked, "scheduling" if someone is trying to schedule or sharing availability, or "none" if neither. No explanation.',
      userMessage: `Subject: ${subject}\n\n${body.slice(0, 500)}`,
    });

    const answer = response.trim().toLowerCase();
    if (answer === 'confirmed') return 'booking_confirmed';
    if (answer === 'scheduling') return 'scheduling_intent';
    return 'no_signal';
  } catch {
    // AI failure should never block sync — silently fall back to no_signal
    return 'no_signal';
  }
}
