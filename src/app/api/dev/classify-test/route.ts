import { NextResponse } from 'next/server';
import { classifyFirstReply } from '@/lib/ai/first-reply-classifier';
import { BOOKING_URL } from '@/lib/constants';

export const maxDuration = 60;

// Local-only test harness for the first-reply classifier. Hits OpenRouter for
// each synthetic case so we can review real model output before shipping.
// Returns 404 in production.

interface TestCase {
  id: string;
  expected: string;
  contactName: string;
  contactRole: string;
  companyName: string;
  latestInboundBody: string;
  threadContext?: string;
}

const DEFAULT_THREAD = `[Us]: Hey {{name}}, I'm a Berkeley student working on a PM command center tool called Proxi. Would love to learn how you think about product prioritization at {{company}}. Do you have 20 minutes next week?`;

const TEST_CASES: TestCase[] = [
  // --- positive_book variants ---
  {
    id: '01_positive_explicit',
    expected: 'positive_book',
    contactName: 'Sarah Chen',
    contactRole: 'Head of Product',
    companyName: 'Acme Corp',
    latestInboundBody: "Sounds good! What times work for you next week? I'm pretty open Tuesday and Thursday afternoons.",
  },
  {
    id: '02_positive_terse',
    expected: 'positive_book',
    contactName: 'Mike Patel',
    contactRole: 'PM',
    companyName: 'BetaCo',
    latestInboundBody: "sure lets do it",
  },
  {
    id: '03_positive_warm',
    expected: 'positive_book',
    contactName: 'Jenna Ruiz',
    contactRole: 'VP Product',
    companyName: 'Gamma Labs',
    latestInboundBody: "Thanks for reaching out, happy to chat! Shoot me a link and I'll grab a time.",
  },
  // --- async_request variants ---
  {
    id: '04_async_explicit',
    expected: 'async_request',
    contactName: 'Daniel Okonkwo',
    contactRole: 'Senior PM',
    companyName: 'Delta Systems',
    latestInboundBody: "I don't really have time for a call but happy to answer questions over email if you want to send a few.",
  },
  {
    id: '05_async_curious',
    expected: 'async_request',
    contactName: 'Priya Venkatesan',
    contactRole: 'Head of Product',
    companyName: 'Epsilon AI',
    latestInboundBody: "What specifically are you building? Busy week but interested if you can send me more info.",
  },
  // --- calendly_sent variants ---
  {
    id: '06_calendly_link',
    expected: 'calendly_sent',
    contactName: 'Tom Anderson',
    contactRole: 'Director of Product',
    companyName: 'Zeta Inc',
    latestInboundBody: "Sure, here's my calendar: https://calendly.com/tanderson/30min",
  },
  {
    id: '07_calendly_natural',
    expected: 'calendly_sent',
    contactName: 'Laura Kim',
    contactRole: 'PM',
    companyName: 'Eta Co',
    latestInboundBody: "feel free to grab any open slot on my calendly, link is in my signature",
  },
  // --- ooo variants ---
  {
    id: '08_ooo_formal',
    expected: 'ooo',
    contactName: 'Roger Chen',
    contactRole: 'VP Product',
    companyName: 'Theta Corp',
    latestInboundBody: "I am out of the office until Monday April 20 and will respond to your email when I return. For urgent matters please contact my assistant.",
  },
  {
    id: '09_ooo_casual',
    expected: 'ooo',
    contactName: 'Alex Park',
    contactRole: 'Head of Product',
    companyName: 'Iota Labs',
    latestInboundBody: "Auto-reply: Currently on vacation, back June 3. Will respond then.",
  },
  // --- decline variants ---
  {
    id: '10_decline_soft',
    expected: 'decline',
    contactName: 'Nina Torres',
    contactRole: 'PM',
    companyName: 'Kappa Tech',
    latestInboundBody: "Thanks but we're not really looking for new tools right now. Maybe reach out in a few months.",
  },
  {
    id: '11_decline_hard',
    expected: 'decline',
    contactName: 'James Wu',
    contactRole: 'PM',
    companyName: 'Lambda Inc',
    latestInboundBody: "please remove me from your list. not interested.",
  },
  // --- question_only variants ---
  {
    id: '12_question_pricing',
    expected: 'question_only',
    contactName: 'Maya Singh',
    contactRole: 'Head of Product',
    companyName: 'Mu Corp',
    latestInboundBody: "What does this cost?",
  },
  {
    id: '13_question_technical',
    expected: 'question_only',
    contactName: 'David Ngo',
    contactRole: 'Senior PM',
    companyName: 'Nu Systems',
    latestInboundBody: "Do you integrate with Jira and Linear? We use both.",
  },
  // --- unclear / bs variants ---
  {
    id: '14_unclear_cryptic',
    expected: 'unclear',
    contactName: 'Bob Mitchell',
    contactRole: 'Founder',
    companyName: 'Xi Ventures',
    latestInboundBody: "that's the secret of business",
  },
  {
    id: '15_unclear_ambiguous',
    expected: 'unclear',
    contactName: 'Kate Liu',
    contactRole: 'VP Product',
    companyName: 'Omicron Inc',
    latestInboundBody: "Thanks for reaching out! Super busy this quarter but let me think about it and get back to you.",
  },
];

interface CaseResult {
  id: string;
  expected: string;
  actual: string;
  match: boolean;
  reason: string;
  message: string | null;
  em_dash_violation: boolean;
  booking_link_present?: boolean;
  latency_ms: number;
}

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const start = Date.now();

  const results: CaseResult[] = await Promise.all(
    TEST_CASES.map(async (tc): Promise<CaseResult> => {
      const caseStart = Date.now();
      try {
        const decision = await classifyFirstReply({
          contactName: tc.contactName,
          contactRole: tc.contactRole,
          companyName: tc.companyName,
          senderFirstName: 'Adit',
          bookingUrl: BOOKING_URL,
          latestInboundBody: tc.latestInboundBody,
          threadContext:
            tc.threadContext ||
            DEFAULT_THREAD.replace('{{name}}', tc.contactName.split(' ')[0]).replace('{{company}}', tc.companyName),
        });

        const msg = decision.message || '';
        const emDash = msg.includes('—') || msg.includes('–');
        const bookingLink = msg.includes(BOOKING_URL.split('://')[1] ?? BOOKING_URL);

        return {
          id: tc.id,
          expected: tc.expected,
          actual: decision.classification,
          match: decision.classification === tc.expected,
          reason: decision.reason,
          message: decision.message,
          em_dash_violation: emDash,
          booking_link_present:
            decision.classification === 'positive_book' ? bookingLink : undefined,
          latency_ms: Date.now() - caseStart,
        };
      } catch (err) {
        return {
          id: tc.id,
          expected: tc.expected,
          actual: 'error',
          match: false,
          reason: err instanceof Error ? err.message : String(err),
          message: null,
          em_dash_violation: false,
          latency_ms: Date.now() - caseStart,
        };
      }
    })
  );

  const total = results.length;
  const matches = results.filter(r => r.match).length;
  const emDashViolations = results.filter(r => r.em_dash_violation).length;
  const bookingLinkMissing = results.filter(
    r => r.expected === 'positive_book' && r.booking_link_present === false
  ).length;

  return NextResponse.json(
    {
      summary: {
        total,
        matches,
        accuracy: `${((matches / total) * 100).toFixed(1)}%`,
        em_dash_violations: emDashViolations,
        booking_link_missing: bookingLinkMissing,
        total_latency_ms: Date.now() - start,
      },
      results,
    },
    { status: 200 }
  );
}
