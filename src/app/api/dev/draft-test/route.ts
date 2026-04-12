import { NextResponse } from 'next/server';
import { callAI } from '@/lib/ai/openrouter';
import { BOOKING_URL } from '@/lib/constants';

export const maxDuration = 60;

// Dev-only test harness for the draft-email AI prompt. Tests different
// prospect reply scenarios and checks that the AI draft contains the
// booking link when appropriate and never contains em dashes.
// Returns 404 in production.

interface TestCase {
  id: string;
  description: string;
  stage: string;
  lastInbound: string;
  expectBookingLink: boolean;
  expectNoQuestions: boolean;
}

const TEST_CASES: TestCase[] = [
  {
    id: '01_positive_simple',
    description: 'Prospect says they are down to talk',
    stage: 'replied',
    lastInbound: "Sure, let me know when works. I typically have time Tuesdays and Thursdays.",
    expectBookingLink: true,
    expectNoQuestions: true,
  },
  {
    id: '02_positive_terse',
    description: 'Very short positive reply',
    stage: 'replied',
    lastInbound: "sounds good, send me a time",
    expectBookingLink: true,
    expectNoQuestions: true,
  },
  {
    id: '03_positive_warm',
    description: 'Warm positive with context',
    stage: 'replied',
    lastInbound: "Hi Srijay, thanks for reaching out! Happy to chat, this sounds interesting. What's your availability like next week?",
    expectBookingLink: true,
    expectNoQuestions: true,
  },
  {
    id: '04_async_explicit',
    description: 'Prospect wants async',
    stage: 'replied',
    lastInbound: "Don't really have time for a call but happy to answer questions over email",
    expectBookingLink: false,
    expectNoQuestions: false,
  },
  {
    id: '05_async_curious',
    description: 'Wants more info async',
    stage: 'replied',
    lastInbound: "Interesting. What specifically are you building? Send me more details",
    expectBookingLink: false,
    expectNoQuestions: false,
  },
  {
    id: '06_calendly_theirs',
    description: 'They sent their own Calendly',
    stage: 'replied',
    lastInbound: "Sure! Here's my calendar: https://calendly.com/jsmith/30min. Book any slot that works for you.",
    expectBookingLink: false,
    expectNoQuestions: true,
  },
  {
    id: '07_scheduling_confirm',
    description: 'Scheduling stage - propose time',
    stage: 'scheduling',
    lastInbound: "How about Thursday at 2pm?",
    expectBookingLink: false,
    expectNoQuestions: true,
  },
  {
    id: '08_positive_brief',
    description: 'Super brief positive',
    stage: 'replied',
    lastInbound: "yeah sure",
    expectBookingLink: true,
    expectNoQuestions: true,
  },
];

interface CaseResult {
  id: string;
  description: string;
  draft: string;
  hasBookingLink: boolean;
  hasEmDash: boolean;
  hasCalendly: boolean;
  hasProxiPitch: boolean;
  expectBookingLink: boolean;
  bookingLinkMatch: boolean;
  latency_ms: number;
}

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const senderName = 'Srijay';

  const results: CaseResult[] = await Promise.all(
    TEST_CASES.map(async (tc): Promise<CaseResult> => {
      const start = Date.now();
      const threadText = `[Us]: Hey, I'm a Berkeley student working on a PM command center tool. Would love to learn how you think about product prioritization at TestCo. Do you have 20 minutes next week?\n\n[Prospect]: ${tc.lastInbound}`;

      const stageInstructions: Record<string, string> = {
        replied: `\n- IMPORTANT: Read the prospect's last message carefully to determine their intent before drafting.
  * If they are POSITIVE about a call ("sure", "happy to chat", "send me a time", "let's do it", "what's your availability"): thank them briefly and include this exact booking link: ${BOOKING_URL}. Do NOT ask questions about their workflow. Just send the link.
  * If they want to do things ASYNC ("don't have time for a call", "send me more info", "what are you building"): ask 2-3 specific questions about how they prioritize at their company and what tools they use. Do NOT include the booking link. Do NOT explain what Proxi does.
  * If they sent their OWN calendar link (Calendly, Cal.com, SavvyCal): acknowledge it and say you'll book a time. Do NOT send our booking link.
  * If they asked a specific QUESTION (pricing, integrations, features): answer briefly if you can, or say you'd love to discuss on a quick call and include the booking link: ${BOOKING_URL}
  * If they DECLINED: do not draft a response. Return an empty string.`,
        scheduling: `\n- We are trying to schedule a call. If they proposed a time, confirm it. If there is a conflict, suggest 2-3 alternative times. If they need a booking link, share: ${BOOKING_URL}`,
      };

      const draft = await callAI({
        model: 'deepseek/deepseek-chat-v3-0324',
        systemPrompt: `You are a sales assistant for Proxi AI (a product prioritization tool for PMs), drafting a follow-up email on behalf of a Berkeley startup founder.

Rules:
- Short and professional, 2-4 sentences max
- NEVER use em dashes (the — character). Use commas or periods instead. This rule is absolute.
- NEVER describe, explain, or pitch what Proxi does or builds. Do not say "our product" or "we're building". Sound like a curious student, not a salesperson.
- No filler phrases ("I hope this finds you well", "Just following up")
- Reference the conversation naturally
- End with a clear next step or question
- Sign off with just the sender's first name on a new line
- Output ONLY the email body, no subject line, no "Dear X"${stageInstructions[tc.stage] || ''}`,
        userMessage: `Contact: Prospect at TestCo
Current pipeline stage: ${tc.stage}

Email thread (oldest first):
${threadText}

Draft a short professional follow-up reply.`,
      });

      const scrubbed = draft.replaceAll('—', ', ').replaceAll('–', ', ').replace(/\s+,/g, ',').trim();

      return {
        id: tc.id,
        description: tc.description,
        draft: scrubbed,
        hasBookingLink: scrubbed.includes('pmcrminternal.vercel.app/book'),
        hasEmDash: scrubbed.includes('—') || scrubbed.includes('–'),
        hasCalendly: scrubbed.includes('calendly.com'),
        hasProxiPitch: /proxi\s+(is|does|builds|helps|offers|provides)/i.test(scrubbed) || scrubbed.includes('our product'),
        expectBookingLink: tc.expectBookingLink,
        bookingLinkMatch: tc.expectBookingLink === scrubbed.includes('pmcrminternal.vercel.app/book'),
        latency_ms: Date.now() - start,
      };
    })
  );

  const total = results.length;
  const bookingCorrect = results.filter(r => r.bookingLinkMatch).length;
  const emDashFree = results.filter(r => !r.hasEmDash).length;
  const calendlyFree = results.filter(r => !r.hasCalendly).length;
  const pitchFree = results.filter(r => !r.hasProxiPitch).length;

  return NextResponse.json({
    summary: {
      total,
      booking_link_correct: `${bookingCorrect}/${total}`,
      em_dash_free: `${emDashFree}/${total}`,
      no_fake_calendly: `${calendlyFree}/${total}`,
      no_proxi_pitch: `${pitchFree}/${total}`,
    },
    results,
  });
}
