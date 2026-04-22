/**
 * Test suite for the bulletproof auto-reply pipeline
 * Runs 40 test cases through classifier -> edge detector -> writer
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { classifyReply } from '../src/lib/ai/reply-classifier';
import { detectEdgeCases } from '../src/lib/ai/edge-case-detector';
import { writeReply } from '../src/lib/ai/reply-writer';
import { preFilter } from '../src/lib/automation/auto-reply-prefilter';
import * as fs from 'fs';

interface TestCase {
  id: number;
  category: string;
  contactName: string;
  companyName: string;
  subject: string;
  body: string;
}

interface TestResult {
  id: number;
  input: {
    category: string;
    contactName: string;
    companyName: string;
    body: string;
  };
  prefilter: {
    action: string;
    reason: string;
  };
  classifier?: {
    primary_category: string;
    secondary_categories: string[];
    confidence: number;
    embedded_questions: string[];
    flags: string[];
  };
  edge_detector?: {
    safe_to_auto_reply: boolean;
    recommendation: string;
    concerns: string[];
    scores: {
      intent_clarity: number;
      tone_safety: number;
      request_type: number;
      context_fit: number;
      weighted_total: number;
    };
  };
  writer?: {
    message: string;
    categories_addressed: string[];
  };
  final_action: 'SEND' | 'FOUNDER' | 'SKIP';
  final_reason: string;
}

const TEST_CASES: TestCase[] = [
  // POSITIVE CATEGORY TESTS
  {
    id: 1,
    category: 'positive_enthusiastic',
    contactName: 'Sarah Chen',
    companyName: 'Stripe',
    subject: 'Re: product prioritization at Stripe',
    body: 'Yes! Would love to chat. This sounds really interesting.',
  },
  {
    id: 2,
    category: 'positive_casual',
    contactName: 'Mike Rodriguez',
    companyName: 'Notion',
    subject: 'Re: product prioritization at Notion',
    body: 'Sure, happy to chat.',
  },
  {
    id: 3,
    category: 'positive_send_times',
    contactName: 'Emma Wilson',
    companyName: 'Figma',
    subject: 'Re: product prioritization at Figma',
    body: 'Sounds good. Send me some times that work for you.',
  },
  {
    id: 4,
    category: 'positive_specific_day',
    contactName: 'James Park',
    companyName: 'Airbnb',
    subject: 'Re: product prioritization at Airbnb',
    body: 'How about Tuesday afternoon? I have some time around 2-4pm PT.',
  },
  {
    id: 5,
    category: 'positive_calendly_request',
    contactName: 'Lisa Wang',
    companyName: 'Plaid',
    subject: 'Re: product prioritization at Plaid',
    body: 'Sure thing. Do you have a Calendly or booking link?',
  },

  // POSITIVE + INFO COMBO TESTS (multi-category)
  {
    id: 6,
    category: 'positive_plus_how_found',
    contactName: 'Faisal Ahmed',
    companyName: 'Ramp',
    subject: 'Re: product prioritization at Ramp',
    body: 'Yes we could jump on a call next week. Out of curiosity how did you come across our company?',
  },
  {
    id: 7,
    category: 'positive_plus_what_is_it',
    contactName: 'Rachel Kim',
    companyName: 'Linear',
    subject: 'Re: product prioritization at Linear',
    body: "Sure, I'm down. But what exactly are you building? I'd like to know more before we chat.",
  },
  {
    id: 8,
    category: 'positive_plus_team',
    contactName: 'David Liu',
    companyName: 'Vercel',
    subject: 'Re: product prioritization at Vercel',
    body: 'Yeah happy to connect. Who are you guys? Tell me a bit about your team.',
  },
  {
    id: 9,
    category: 'positive_plus_multiple_questions',
    contactName: 'Anna Petrova',
    companyName: 'Brex',
    subject: 'Re: product prioritization at Brex',
    body: 'Sounds interesting! A few questions: How did you find me? What are you building exactly? Are you funded?',
  },

  // ASYNC CATEGORY TESTS
  {
    id: 10,
    category: 'async_prefer_email',
    contactName: 'Tom Baker',
    companyName: 'Shopify',
    subject: 'Re: product prioritization at Shopify',
    body: "I'd rather do this over email if that's ok. What did you want to discuss?",
  },
  {
    id: 11,
    category: 'async_send_info',
    contactName: 'Jennifer Lee',
    companyName: 'Square',
    subject: 'Re: product prioritization at Square',
    body: 'Can you send me more info first? I want to see if this is relevant before committing to a call.',
  },
  {
    id: 12,
    category: 'async_busy_no_call',
    contactName: 'Chris Johnson',
    companyName: 'Coinbase',
    subject: 'Re: product prioritization at Coinbase',
    body: "Too busy for calls right now but happy to chat over email. What's on your mind?",
  },

  // INFO REQUEST TESTS (standalone)
  {
    id: 13,
    category: 'info_what_is_it',
    contactName: 'Michelle Torres',
    companyName: 'DoorDash',
    subject: 'Re: product prioritization at DoorDash',
    body: "What is Proxi? I've never heard of you.",
  },
  {
    id: 14,
    category: 'info_how_found',
    contactName: 'Kevin Patel',
    companyName: 'Instacart',
    subject: 'Re: product prioritization at Instacart',
    body: 'How did you find me? Just curious.',
  },
  {
    id: 15,
    category: 'info_why_me',
    contactName: 'Samantha White',
    companyName: 'Robinhood',
    subject: 'Re: product prioritization at Robinhood',
    body: "Why are you reaching out to me specifically? I'm not even in product.",
  },

  // DELAY CATEGORY TESTS
  {
    id: 16,
    category: 'delay_specific_date',
    contactName: 'Robert Garcia',
    companyName: 'Lyft',
    subject: 'Re: product prioritization at Lyft',
    body: "Reach out after May 15th. We're in the middle of a big launch right now.",
  },
  {
    id: 17,
    category: 'delay_next_quarter',
    contactName: 'Nicole Adams',
    companyName: 'Uber',
    subject: 'Re: product prioritization at Uber',
    body: 'Not a good time right now. Can you follow up next quarter?',
  },
  {
    id: 18,
    category: 'delay_traveling',
    contactName: 'Brian Thompson',
    companyName: 'Dropbox',
    subject: 'Re: product prioritization at Dropbox',
    body: "I'm traveling until the end of the month. Let's connect when I'm back.",
  },
  {
    id: 19,
    category: 'delay_busy_generic',
    contactName: 'Amanda Clark',
    companyName: 'Slack',
    subject: 'Re: product prioritization at Slack',
    body: 'Swamped right now. Maybe in a few weeks?',
  },
  {
    id: 20,
    category: 'delay_plus_positive',
    contactName: 'Steven Wright',
    companyName: 'Zoom',
    subject: 'Re: product prioritization at Zoom',
    body: "I'm interested but traveling until March 20. Can we chat after I get back?",
  },

  // DECLINE CATEGORY TESTS (should NOT auto-reply)
  {
    id: 21,
    category: 'decline_polite',
    contactName: 'Laura Martinez',
    companyName: 'Twitter',
    subject: 'Re: product prioritization at Twitter',
    body: "Thanks for reaching out but this isn't a fit for us right now. Good luck!",
  },
  {
    id: 22,
    category: 'decline_firm',
    contactName: 'Mark Davis',
    companyName: 'Meta',
    subject: 'Re: product prioritization at Meta',
    body: 'Not interested.',
  },
  {
    id: 23,
    category: 'decline_unsubscribe',
    contactName: 'Karen Brown',
    companyName: 'Google',
    subject: 'Re: product prioritization at Google',
    body: 'Please remove me from your list. Stop emailing me.',
  },

  // EDGE CASE TESTS (should route to FOUNDER)
  {
    id: 24,
    category: 'edge_resume',
    contactName: 'Alex Turner',
    companyName: 'Netflix',
    subject: 'Re: product prioritization at Netflix',
    body: "Sure! Also, I'm looking for new opportunities. Here's my resume if you're hiring.",
  },
  {
    id: 25,
    category: 'edge_linkedin',
    contactName: 'Maria Gonzalez',
    companyName: 'Amazon',
    subject: 'Re: product prioritization at Amazon',
    body: "Let's connect on LinkedIn first. Add me: linkedin.com/in/mariagonzalez",
  },
  {
    id: 26,
    category: 'edge_sales_pitch',
    contactName: 'Jason Miller',
    companyName: 'Salesforce',
    subject: 'Re: product prioritization at Salesforce',
    body: 'Actually, we have a tool that might help YOU. Can I tell you about our product?',
  },
  {
    id: 27,
    category: 'edge_partnership',
    contactName: 'Emily Chen',
    companyName: 'Adobe',
    subject: 'Re: product prioritization at Adobe',
    body: "Yes! And we should totally partner up. Let's discuss a collaboration.",
  },
  {
    id: 28,
    category: 'edge_sarcastic',
    contactName: 'Derek Jones',
    companyName: 'Apple',
    subject: 'Re: product prioritization at Apple',
    body: 'lol ok whatever. I guess?',
  },
  {
    id: 29,
    category: 'edge_hostile',
    contactName: 'Tony Stark',
    companyName: 'Stark Industries',
    subject: 'Re: product prioritization at Stark Industries',
    body: "How did you get my email? This is spam. I'm reporting you.",
  },
  {
    id: 30,
    category: 'edge_one_word',
    contactName: 'Simple Sam',
    companyName: 'SimpleCo',
    subject: 'Re: product prioritization at SimpleCo',
    body: 'ok',
  },
  {
    id: 31,
    category: 'edge_contact_request',
    contactName: 'Privacy Pete',
    companyName: 'PrivacyCorp',
    subject: 'Re: product prioritization at PrivacyCorp',
    body: "Sure, what's your personal cell number? I prefer texting.",
  },
  {
    id: 32,
    category: 'edge_competitor',
    contactName: 'Competitor Carl',
    companyName: 'ProductBoard',
    subject: 'Re: product prioritization at ProductBoard',
    body: "Interesting. We actually build prioritization tools ourselves at ProductBoard. Curious what you're doing differently.",
  },

  // QUESTION CATEGORY TESTS (should route to FOUNDER)
  {
    id: 33,
    category: 'question_compliance',
    contactName: 'Compliance Carol',
    companyName: 'BigBank',
    subject: 'Re: product prioritization at BigBank',
    body: 'Are you SOC2 compliant? We can only work with vendors that meet our security requirements.',
  },
  {
    id: 34,
    category: 'question_technical',
    contactName: 'Tech Ted',
    companyName: 'TechCorp',
    subject: 'Re: product prioritization at TechCorp',
    body: 'Do you integrate with Jira? What about Slack? We need API access.',
  },
  {
    id: 35,
    category: 'question_pricing',
    contactName: 'Budget Betty',
    companyName: 'BudgetCo',
    subject: 'Re: product prioritization at BudgetCo',
    body: "How much does it cost? What's your pricing model?",
  },

  // REFERRAL TESTS (should route to FOUNDER)
  {
    id: 36,
    category: 'referral_named',
    contactName: 'Referral Rick',
    companyName: 'RefCorp',
    subject: 'Re: product prioritization at RefCorp',
    body: "I'm not the right person. Talk to Sarah Johnson, she handles product. Her email is sarah@refcorp.com",
  },
  {
    id: 37,
    category: 'referral_unknown',
    contactName: 'Wrong Person Wendy',
    companyName: 'WrongCo',
    subject: 'Re: product prioritization at WrongCo',
    body: "You've got the wrong person. Someone else on my team might be interested though.",
  },

  // OOO / AUTO-REPLY TESTS (should SKIP via prefilter)
  {
    id: 38,
    category: 'ooo_auto_reply',
    contactName: 'Vacation Vic',
    companyName: 'VacationCo',
    subject: 'Out of Office: Re: product prioritization at VacationCo',
    body: 'I am currently out of the office with limited access to email. I will return on May 1st. For urgent matters, contact my colleague at backup@vacationco.com.',
  },
  {
    id: 39,
    category: 'ooo_traveling',
    contactName: 'Travel Tina',
    companyName: 'TravelCo',
    subject: 'Re: product prioritization at TravelCo',
    body: "Auto-reply: I'm traveling and will respond when I return on April 30th.",
  },

  // CALENDLY SENT TEST (should route to FOUNDER)
  {
    id: 40,
    category: 'calendly_sent',
    contactName: 'Calendly Casey',
    companyName: 'CalendarCo',
    subject: 'Re: product prioritization at CalendarCo',
    body: "Sure! Here's my Calendly: https://calendly.com/casey-calendar/30min",
  },
];

async function runTests(): Promise<void> {
  const results: TestResult[] = [];

  console.log('Starting auto-reply pipeline tests...\n');
  console.log('='.repeat(80));

  for (const testCase of TEST_CASES) {
    console.log(`\nTest ${testCase.id}: ${testCase.category} (${testCase.contactName} @ ${testCase.companyName})`);

    const result: TestResult = {
      id: testCase.id,
      input: {
        category: testCase.category,
        contactName: testCase.contactName,
        companyName: testCase.companyName,
        body: testCase.body,
      },
      prefilter: { action: '', reason: '' },
      final_action: 'SKIP',
      final_reason: '',
    };

    try {
      // Stage 1: Pre-filter
      const preFilterResult = preFilter({
        subject: testCase.subject,
        body: testCase.body,
        inboundTime: new Date(),
        inboundAgeHours: 1,
        ownerGmailConnected: true,
        interactions: [],
      });

      result.prefilter = {
        action: preFilterResult.action,
        reason: preFilterResult.reason,
      };

      if (preFilterResult.action === 'skip') {
        result.final_action = 'SKIP';
        result.final_reason = `prefilter: ${preFilterResult.reason}`;
        console.log(`  -> SKIP (prefilter: ${preFilterResult.reason})`);
        results.push(result);
        continue;
      }

      if (preFilterResult.action === 'founder') {
        result.final_action = 'FOUNDER';
        result.final_reason = `prefilter: ${preFilterResult.reason}`;
        console.log(`  -> FOUNDER (prefilter: ${preFilterResult.reason})`);
        results.push(result);
        continue;
      }

      // Stage 2: Classifier
      const classifierResult = await classifyReply({
        contactName: testCase.contactName,
        companyName: testCase.companyName,
        latestInboundSubject: testCase.subject,
        latestInboundBody: testCase.body,
        threadContext: '',
      });

      result.classifier = {
        primary_category: classifierResult.primary_category,
        secondary_categories: classifierResult.secondary_categories,
        confidence: classifierResult.confidence,
        embedded_questions: classifierResult.embedded_questions,
        flags: classifierResult.flags,
      };

      console.log(`  Classifier: ${classifierResult.primary_category} (${classifierResult.confidence.toFixed(2)})`);
      if (classifierResult.secondary_categories.length > 0) {
        console.log(`    Secondary: ${classifierResult.secondary_categories.join(', ')}`);
      }
      if (classifierResult.embedded_questions.length > 0) {
        console.log(`    Questions: ${classifierResult.embedded_questions.join(', ')}`);
      }

      // Check if classifier routes to founder
      if (classifierResult.primary_category.startsWith('edge_') ||
          classifierResult.primary_category.startsWith('question_') ||
          classifierResult.primary_category.startsWith('referral') ||
          classifierResult.primary_category === 'calendly_sent' ||
          classifierResult.confidence < 0.7) {
        result.final_action = 'FOUNDER';
        result.final_reason = `classifier: ${classifierResult.primary_category} (conf: ${classifierResult.confidence.toFixed(2)})`;
        console.log(`  -> FOUNDER (${result.final_reason})`);
        results.push(result);
        continue;
      }

      // Check if decline (no response needed)
      if (classifierResult.primary_category.startsWith('decline')) {
        result.final_action = 'SKIP';
        result.final_reason = `decline: ${classifierResult.primary_category}`;
        console.log(`  -> SKIP (${result.final_reason})`);
        results.push(result);
        continue;
      }

      // Stage 3: Edge Detector
      const edgeResult = await detectEdgeCases({
        contactName: testCase.contactName,
        companyName: testCase.companyName,
        latestInboundSubject: testCase.subject,
        latestInboundBody: testCase.body,
        classifierResult,
      });

      result.edge_detector = {
        safe_to_auto_reply: edgeResult.safe_to_auto_reply,
        recommendation: edgeResult.recommendation,
        concerns: edgeResult.concerns,
        scores: edgeResult.scores,
      };

      console.log(`  Edge Detector: ${edgeResult.safe_to_auto_reply ? 'SAFE' : 'UNSAFE'} (${edgeResult.scores.weighted_total}/10)`);
      if (edgeResult.concerns.length > 0) {
        console.log(`    Concerns: ${edgeResult.concerns.join(', ')}`);
      }

      if (!edgeResult.safe_to_auto_reply || edgeResult.recommendation !== 'send') {
        result.final_action = 'FOUNDER';
        result.final_reason = `edge_detector: ${edgeResult.concerns.join(', ') || edgeResult.reasoning} (${edgeResult.scores.weighted_total}/10)`;
        console.log(`  -> FOUNDER (${result.final_reason})`);
        results.push(result);
        continue;
      }

      // Stage 4: Writer
      const writerResult = await writeReply({
        contactName: testCase.contactName,
        contactRole: 'PM',
        companyName: testCase.companyName,
        senderFirstName: 'Adit',
        latestInboundBody: testCase.body,
        classifierResult,
      });

      result.writer = {
        message: writerResult.message,
        categories_addressed: writerResult.categories_addressed,
      };

      console.log(`  Writer: ${writerResult.message.slice(0, 80)}...`);

      result.final_action = 'SEND';
      result.final_reason = `categories: ${writerResult.categories_addressed.join(', ')}`;
      console.log(`  -> SEND`);

    } catch (err) {
      result.final_action = 'FOUNDER';
      result.final_reason = `error: ${err instanceof Error ? err.message : String(err)}`;
      console.log(`  -> ERROR: ${result.final_reason}`);
    }

    results.push(result);

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  // Generate report
  console.log('\n' + '='.repeat(80));
  console.log('\nGenerating report...\n');

  const report = generateReport(results);
  fs.writeFileSync('auto-reply-test-report.md', report);
  console.log('Report written to auto-reply-test-report.md');
}

function generateReport(results: TestResult[]): string {
  const sendCount = results.filter(r => r.final_action === 'SEND').length;
  const founderCount = results.filter(r => r.final_action === 'FOUNDER').length;
  const skipCount = results.filter(r => r.final_action === 'SKIP').length;

  let report = `# Auto-Reply Pipeline Test Report

Generated: ${new Date().toISOString()}

## Summary

| Action | Count |
|--------|-------|
| SEND (auto-reply) | ${sendCount} |
| FOUNDER (manual) | ${founderCount} |
| SKIP (no action) | ${skipCount} |
| **Total** | ${results.length} |

---

## Test Results

`;

  for (const r of results) {
    report += `### Test ${r.id}: ${r.input.category}

**Contact:** ${r.input.contactName} @ ${r.input.companyName}

**Input Email:**
> ${r.input.body}

**Pipeline Results:**
- Pre-filter: ${r.prefilter.action} (${r.prefilter.reason})
`;

    if (r.classifier) {
      report += `- Classifier: \`${r.classifier.primary_category}\` (confidence: ${r.classifier.confidence.toFixed(2)})
`;
      if (r.classifier.secondary_categories.length > 0) {
        report += `  - Secondary: ${r.classifier.secondary_categories.join(', ')}
`;
      }
      if (r.classifier.embedded_questions.length > 0) {
        report += `  - Questions detected: ${r.classifier.embedded_questions.join(', ')}
`;
      }
    }

    if (r.edge_detector) {
      report += `- Edge Detector: ${r.edge_detector.safe_to_auto_reply ? 'SAFE' : 'UNSAFE'} (score: ${r.edge_detector.scores.weighted_total}/10)
  - Intent clarity: ${r.edge_detector.scores.intent_clarity}/10
  - Tone safety: ${r.edge_detector.scores.tone_safety}/10
  - Request type: ${r.edge_detector.scores.request_type}/10
  - Context fit: ${r.edge_detector.scores.context_fit}/10
`;
      if (r.edge_detector.concerns.length > 0) {
        report += `  - Concerns: ${r.edge_detector.concerns.join(', ')}
`;
      }
    }

    report += `
**Final Action:** \`${r.final_action}\`
**Reason:** ${r.final_reason}

`;

    if (r.writer && r.final_action === 'SEND') {
      report += `**Generated Reply:**
\`\`\`
Hi ${r.input.contactName.split(' ')[0]},

${r.writer.message}

Best,
Adit
\`\`\`

`;
    }

    report += `---

`;
  }

  return report;
}

runTests().catch(console.error);
