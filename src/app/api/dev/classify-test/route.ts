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
  // GROUP A: Positive (auto-reply with booking link)
  { id: '01_positive_enthusiastic', expected: 'positive_enthusiastic', contactName: 'Sarah Chen', contactRole: 'Head of Product', companyName: 'Acme Corp', latestInboundBody: "Yes! Would love to chat about this. Super excited to hear what you're building!" },
  { id: '02_positive_casual', expected: 'positive_casual', contactName: 'Mike Patel', contactRole: 'PM', companyName: 'BetaCo', latestInboundBody: "sure lets do it" },
  { id: '03_positive_send_times', expected: 'positive_send_times', contactName: 'Jenna Ruiz', contactRole: 'VP Product', companyName: 'Gamma Labs', latestInboundBody: "Sounds good, send me some times that work for you." },
  { id: '04_positive_specific_day', expected: 'positive_specific_day', contactName: 'Alex Kim', contactRole: 'Senior PM', companyName: 'Nova Inc', latestInboundBody: "How about next Tuesday afternoon?" },

  // GROUP B: Async/email preference
  { id: '05_async_prefer_email', expected: 'async_prefer_email', contactName: 'Daniel Okonkwo', contactRole: 'Senior PM', companyName: 'Delta Systems', latestInboundBody: "I don't really have time for a call but happy to answer questions over email if you want to send a few." },
  { id: '06_async_send_info', expected: 'async_send_info', contactName: 'Priya Venkatesan', contactRole: 'Head of Product', companyName: 'Epsilon AI', latestInboundBody: "Send me more info first. What exactly are you building?" },
  { id: '07_async_busy', expected: 'async_busy', contactName: 'Chris Wong', contactRole: 'PM Lead', companyName: 'Zephyr Tech', latestInboundBody: "Super busy right now, just email me what you need" },

  // GROUP C: Info request
  { id: '08_info_what_is_it', expected: 'info_what_is_it', contactName: 'Rachel Park', contactRole: 'Director PM', companyName: 'Helios', latestInboundBody: "What is Proxi exactly? What does your tool do?" },
  { id: '09_info_team', expected: 'info_team', contactName: 'Tom Brown', contactRole: 'VP Product', companyName: 'Titan Co', latestInboundBody: "Who are you guys? What's your background?" },
  { id: '10_info_funding', expected: 'info_funding', contactName: 'Lisa Chen', contactRole: 'Head of Product', companyName: 'Atlas Corp', latestInboundBody: "Are you funded? Do you have any investors?" },
  { id: '11_info_general', expected: 'info_general', contactName: 'Kevin Nguyen', contactRole: 'Senior PM', companyName: 'Orion Labs', latestInboundBody: "Is this an AI tool? How does it work?" },

  // GROUP D: Delay (schedule follow-up)
  { id: '12_delay_specific_date', expected: 'delay_specific_date', contactName: 'Emma Wilson', contactRole: 'PM', companyName: 'Vertex Inc', latestInboundBody: "Follow up after May 15th, slammed until then." },
  { id: '13_delay_after_event', expected: 'delay_after_event', contactName: 'James Lee', contactRole: 'VP Product', companyName: 'Nexus Co', latestInboundBody: "Once our product launch is done next month, let's chat." },
  { id: '14_delay_traveling', expected: 'delay_traveling', contactName: 'Anna Martinez', contactRole: 'Head of Product', companyName: 'Apex Tech', latestInboundBody: "I'm traveling until the 20th. Back in office next Monday." },
  { id: '15_delay_generic', expected: 'delay_generic', contactName: 'Kate Liu', contactRole: 'VP Product', companyName: 'Omicron Inc', latestInboundBody: "Not a good time right now. Maybe reach out again in a few weeks." },
  { id: '16_delay_ooo', expected: 'delay_ooo', contactName: 'Roger Chen', contactRole: 'VP Product', companyName: 'Theta Corp', latestInboundBody: "I am out of the office until Monday April 28 and will respond to your email when I return. For urgent matters please contact my assistant." },

  // GROUP E: Referral
  { id: '17_referral_named', expected: 'referral_named', contactName: 'Sam Johnson', contactRole: 'CEO', companyName: 'Pulse Tech', latestInboundBody: "You should talk to Sarah Chen, she handles all the PM stuff. Her email is sarah@pulse.tech" },
  { id: '18_referral_unknown', expected: 'referral_unknown', contactName: 'David Kim', contactRole: 'CTO', companyName: 'Wave Co', latestInboundBody: "I'm not the right person for this. Try someone else on the product team." },

  // GROUP F: Decline (NO auto-reply)
  { id: '19_decline_polite', expected: 'decline_polite', contactName: 'Nina Torres', contactRole: 'PM', companyName: 'Kappa Tech', latestInboundBody: "Thanks but we're not really looking for new tools right now. Appreciate it though!" },
  { id: '20_decline_firm', expected: 'decline_firm', contactName: 'James Wu', contactRole: 'PM', companyName: 'Lambda Inc', latestInboundBody: "Not interested. Please don't contact me again." },
  { id: '21_decline_unsubscribe', expected: 'decline_unsubscribe', contactName: 'Mark Davis', contactRole: 'PM Lead', companyName: 'Sigma Corp', latestInboundBody: "Unsubscribe. Remove me from your list." },

  // GROUP G: Manual review
  { id: '22_calendly_sent', expected: 'calendly_sent', contactName: 'Tom Anderson', contactRole: 'Director of Product', companyName: 'Zeta Inc', latestInboundBody: "Sure, here's my calendar: https://calendly.com/tanderson/30min" },
  { id: '23_question_compliance', expected: 'question_compliance', contactName: 'Laura Kim', contactRole: 'VP Product', companyName: 'Eta Co', latestInboundBody: "Do you have SOC 2 certification? What about GDPR compliance?" },
  { id: '24_question_technical', expected: 'question_technical', contactName: 'David Ngo', contactRole: 'Senior PM', companyName: 'Nu Systems', latestInboundBody: "Do you integrate with Jira and Linear? What's your API like?" },
  { id: '25_question_pricing', expected: 'question_pricing', contactName: 'Maya Singh', contactRole: 'Head of Product', companyName: 'Mu Corp', latestInboundBody: "What does this cost? What's your pricing model?" },

  // Fallback
  { id: '26_unclear', expected: 'unclear', contactName: 'Bob Mitchell', contactRole: 'Founder', companyName: 'Xi Ventures', latestInboundBody: "that's the secret of business" },
];

interface CaseResult {
  id: string;
  expected: string;
  actual: string;
  match: boolean;
  reason: string;
  follow_up_date?: string | null;
  referral_name?: string | null;
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

        return {
          id: tc.id,
          expected: tc.expected,
          actual: decision.category,
          match: decision.category === tc.expected,
          reason: decision.reason,
          follow_up_date: decision.follow_up_date,
          referral_name: decision.referral_name,
          latency_ms: Date.now() - caseStart,
        };
      } catch (err) {
        return {
          id: tc.id,
          expected: tc.expected,
          actual: 'error',
          match: false,
          reason: err instanceof Error ? err.message : String(err),
          latency_ms: Date.now() - caseStart,
        };
      }
    })
  );

  const total = results.length;
  const matches = results.filter(r => r.match).length;
  const delayWithDates = results.filter(r => r.expected.startsWith('delay_') && r.follow_up_date).length;
  const referralsWithNames = results.filter(r => r.expected === 'referral_named' && r.referral_name).length;

  return NextResponse.json(
    {
      summary: {
        total,
        matches,
        accuracy: `${((matches / total) * 100).toFixed(1)}%`,
        delay_categories_with_dates: delayWithDates,
        referrals_with_names: referralsWithNames,
        total_latency_ms: Date.now() - start,
      },
      results,
    },
    { status: 200 }
  );
}
