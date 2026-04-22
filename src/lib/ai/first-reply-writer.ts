/**
 * Haiku-only email body writer. Every auto-sent email body (first-reply
 * reply, fast-loop follow-up, info-request reply, 48h follow-up) is composed
 * here, then run through `formatEmailBody()` by the caller. The writer never
 * emits a greeting or signoff — those are appended by the formatter.
 */

import { callAI } from '@/lib/ai/openrouter';
import { WRITER_MODEL } from '@/lib/constants';
import type { QaItem } from '@/lib/ai/qa-bank';

export interface BaseWriteOpts {
  contactName: string;
  contactRole: string | null | undefined;
  companyName: string;
  senderFirstName: string;
  bookingUrl: string;
  latestInboundBody: string;
  threadContext: string;
}

const SHARED_RULES = `You are writing a short email body as a Berkeley student founder named {{SENDER}}. The recipient is a product manager or operator we want to learn from, not sell to.

Hard rules (violation makes the output invalid):
- Output ONLY the body text. No greeting. No signoff. No subject. The caller adds "Hi <name>," at the top and "Best,\\n<name>" at the bottom.
- NEVER use em dashes (—) or en dashes (–). Use commas or periods.
- NEVER describe, explain, summarize, or pitch Proxi. If they ask "what are you building", pivot to learning from them.
- 2 to 4 sentences. Shorter is better. Plain text only, no bullets, no emoji, no headers, no bold.
- Contractions are fine. Warm, curious, respectful tone.
- No filler phrases ("I hope this finds you well", "Just following up", "Just wanted to check in", "I hope you're doing well").
- Forbidden words: exciting, game-changing, revolutionary, solution, platform, leverage, unlock.
- Separate every paragraph with a blank line.
- Every message ends on a concrete next step or a single question.`;

function buildShared(opts: BaseWriteOpts): string {
  const role = opts.contactRole
    ? `${opts.contactRole} at ${opts.companyName}`
    : opts.companyName;
  return `Prospect: ${opts.contactName}, ${role}
Sender first name: ${opts.senderFirstName}
Booking link (use exactly once, only where natural): ${opts.bookingUrl}

Recent thread (oldest first):
${opts.threadContext || '(no prior thread context)'}

Latest inbound reply from prospect:
"${opts.latestInboundBody.slice(0, 1500)}"`;
}

async function write(system: string, user: string, senderFirstName: string): Promise<string> {
  const systemWithSender = system.replaceAll('{{SENDER}}', senderFirstName);
  return callAI({
    model: WRITER_MODEL,
    systemPrompt: systemWithSender,
    userMessage: user,
    maxTokens: 400,
  });
}

// ── positive_book — prospect is open to a call ────────────────────────────

export async function writePositiveBookReply(opts: BaseWriteOpts): Promise<string> {
  const system = `${SHARED_RULES}

Specific to this reply:
- They already agreed to chat. Main goal: give them the booking link.
- FORBIDDEN: Any sentence containing "curious", "interested", "learn", "hear", "understand", or any question mark.

SPECIAL CASE: If they asked "how did you find us/me" or "how did you come across" our company:
- First, answer briefly in ONE sentence: we were researching high-growth tech companies and their product/prioritization approach, and they stood out.
- Keep it casual and honest, like "We were researching high-growth companies and how they think about product, and you all stood out."
- Then proceed to the booking link structure below.

Standard structure (adapt if you answered a "how did you find us" question above):
  1. One short thank-you phrase (max 8 words). Example: "Thanks for being open to this."
  2. The booking link on its own line.
  3. One short closing sentence inviting them to grab a time. Example: "Grab any time that works."
- Total output: 4 lines max. Do NOT add extra context beyond what's specified above.`;
  return write(system, buildShared(opts), opts.senderFirstName);
}

// ── async_request — they want to do this over email ───────────────────────

export async function writeAsyncRequestReply(opts: BaseWriteOpts): Promise<string> {
  const system = `${SHARED_RULES}

Specific to this reply:
- Acknowledge they prefer email.
- Ask 2 to 3 specific questions. Base them on what they said whenever possible. If they gave nothing substantive, default to these two questions exactly:
  1. How did you decide what to prioritize at your company this quarter?
  2. What tools or software do you use today to collect and act on customer feedback?
- Do NOT mention a call or the booking link.
- Do NOT pitch or describe what Proxi does, even if they asked "what are you building".`;
  return write(system, buildShared(opts), opts.senderFirstName);
}

// ── info_request — light-touch product curiosity ──────────────────────────

export interface InfoRequestWriteOpts extends BaseWriteOpts {
  qaMatches: QaItem[];
}

export async function writeInfoRequestReply(opts: InfoRequestWriteOpts): Promise<string> {
  const qaContext = opts.qaMatches.length
    ? opts.qaMatches
        .map((q, i) => `Reference answer ${i + 1} (id: ${q.id}):\n${q.answer}`)
        .join('\n\n')
    : '(no reference answers — answer briefly and pivot to a question)';

  const system = `${SHARED_RULES}

Specific to this reply:
- Blend at most 2 of the reference answers below into a 3-4 sentence response. Do NOT copy them verbatim — rephrase in your voice.
- Answer just enough to satisfy their curiosity without pitching.
- Close with either the booking link ("${opts.bookingUrl}") on its own paragraph OR a single question inviting them to share how they think about the topic they raised.
- Pick only one of those two closes, not both.

Reference answers for this prospect's question:
${qaContext}`;
  return write(system, buildShared(opts), opts.senderFirstName);
}

// ── fast-loop follow-up — sent 30-120min after first auto-reply ──────────

export interface FastLoopWriteOpts extends BaseWriteOpts {
  prevOutboundBody: string;
}

export async function writeFastLoopFollowup(opts: FastLoopWriteOpts): Promise<string> {
  const system = `${SHARED_RULES}

Specific to this fast-loop follow-up:
- This is a LIGHT second nudge after you already sent a warm reply. Do NOT repeat what you said. Do NOT apologize.
- Keep it to 1 or 2 sentences. Shorter is better.
- If the previous message included a booking link, restate it once in a single sentence. If it did not, ask a single curious question about their current prioritization workflow.
- Never say "just following up" or "circling back" or "bumping this".`;
  const user = `${buildShared(opts)}

My previous message to them (sent 30-120 minutes ago):
"${opts.prevOutboundBody.slice(0, 800)}"`;
  return write(system, user, opts.senderFirstName);
}

// ── 48h follow-up — sent 48+ hours after last outbound ────────────────────

export interface FollowupWriteOpts extends BaseWriteOpts {
  prevOutboundBody: string;
  hoursAgo: number;
}

export async function write48hFollowup(opts: FollowupWriteOpts): Promise<string> {
  const system = `${SHARED_RULES}

Specific to this 48-hour follow-up:
- This is a warm check-in after a gap of ${opts.hoursAgo} hours since your last message.
- 1 to 2 sentences. Reference the context naturally without repeating full content.
- End with a single clear question or a concrete next step.
- Never say "just following up", "circling back", or "bumping this".`;
  const user = `${buildShared(opts)}

My last email to them (sent ${opts.hoursAgo}h ago):
"${opts.prevOutboundBody.slice(0, 800)}"`;
  return write(system, user, opts.senderFirstName);
}
