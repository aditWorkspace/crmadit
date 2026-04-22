/**
 * Test suite v2 for the bulletproof auto-reply pipeline
 * Focus: Startups, college student context, product validation framing
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

// Focus on STARTUPS and realistic college student outreach scenarios
const TEST_CASES: TestCase[] = [
  // POSITIVE - STARTUPS
  {
    id: 1,
    category: 'positive_enthusiastic_startup',
    contactName: 'Maya Patel',
    companyName: 'Retool',
    subject: 'Re: product prioritization at Retool',
    body: 'Yeah for sure! Always happy to chat with students. Send over a time.',
  },
  {
    id: 2,
    category: 'positive_casual_startup',
    contactName: 'Jake Morrison',
    companyName: 'Notion',
    subject: 'Re: product prioritization at Notion',
    body: 'Sure thing, happy to help out. What works for you?',
  },
  {
    id: 3,
    category: 'positive_warm_startup',
    contactName: 'Priya Sharma',
    companyName: 'Loom',
    subject: 'Re: product prioritization at Loom',
    body: 'Love that you guys are doing customer discovery! Happy to chat. Do you have a calendly?',
  },
  {
    id: 4,
    category: 'positive_specific_time',
    contactName: 'Ryan Chen',
    companyName: 'Mercury',
    subject: 'Re: product prioritization at Mercury',
    body: 'How about Thursday at 3pm? I have 30 min free.',
  },
  {
    id: 5,
    category: 'positive_next_week',
    contactName: 'Alicia Wong',
    companyName: 'Amplitude',
    subject: 'Re: product prioritization at Amplitude',
    body: 'Sure, next week works better for me. Send some times!',
  },

  // POSITIVE + INFO COMBOS
  {
    id: 6,
    category: 'positive_plus_how_found',
    contactName: 'Daniel Kim',
    companyName: 'Rippling',
    subject: 'Re: product prioritization at Rippling',
    body: 'Sure, happy to chat! Quick question though - how did you find me?',
  },
  {
    id: 7,
    category: 'positive_plus_what_building',
    contactName: 'Sophie Zhang',
    companyName: 'Vanta',
    subject: 'Re: product prioritization at Vanta',
    body: 'Yeah I could do a quick call. What exactly are you guys working on?',
  },
  {
    id: 8,
    category: 'positive_plus_berkeley',
    contactName: 'Marcus Lee',
    companyName: 'Ramp',
    subject: 'Re: product prioritization at Ramp',
    body: 'Go Bears! Happy to help a fellow Cal student. What are you building?',
  },
  {
    id: 9,
    category: 'positive_plus_funding',
    contactName: 'Jessica Park',
    companyName: 'Brex',
    subject: 'Re: product prioritization at Brex',
    body: 'Sure! Are you guys funded or still bootstrapping? Either way happy to chat.',
  },

  // ASYNC - EMAIL PREFERENCE
  {
    id: 10,
    category: 'async_prefer_email',
    contactName: 'Kevin Wu',
    companyName: 'Linear',
    subject: 'Re: product prioritization at Linear',
    body: "I'd prefer to do this over email if that's cool. What did you want to know?",
  },
  {
    id: 11,
    category: 'async_send_info',
    contactName: 'Rachel Torres',
    companyName: 'Figma',
    subject: 'Re: product prioritization at Figma',
    body: 'Can you send me a quick overview first? Want to make sure I can actually help.',
  },
  {
    id: 12,
    category: 'async_busy',
    contactName: 'Chris Anderson',
    companyName: 'Vercel',
    subject: 'Re: product prioritization at Vercel',
    body: "Super busy with launches right now. Happy to answer questions over email though. What's on your mind?",
  },
  {
    id: 13,
    category: 'async_quick_questions',
    contactName: 'Emma Davis',
    companyName: 'Clerk',
    subject: 'Re: product prioritization at Clerk',
    body: "I've only got time for email right now. What specific questions do you have?",
  },

  // INFO REQUESTS (standalone)
  {
    id: 14,
    category: 'info_how_found',
    contactName: 'Tom Wright',
    companyName: 'Airbyte',
    subject: 'Re: product prioritization at Airbyte',
    body: 'How did you come across my email?',
  },
  {
    id: 15,
    category: 'info_what_is_it',
    contactName: 'Lisa Chang',
    companyName: 'dbt Labs',
    subject: 'Re: product prioritization at dbt Labs',
    body: "What's this about? I don't think I've heard of you.",
  },
  {
    id: 16,
    category: 'info_why_me',
    contactName: 'Ben Miller',
    companyName: 'Posthog',
    subject: 'Re: product prioritization at Posthog',
    body: 'Why me specifically? I work on analytics not product.',
  },

  // DELAY
  {
    id: 17,
    category: 'delay_specific_date',
    contactName: 'Anna Wilson',
    companyName: 'Notion',
    subject: 'Re: product prioritization at Notion',
    body: 'Can you reach out again after June 1st? Swamped with a big release right now.',
  },
  {
    id: 18,
    category: 'delay_next_month',
    contactName: 'James Chen',
    companyName: 'Stripe',
    subject: 'Re: product prioritization at Stripe',
    body: 'Not a good time right now. Can you follow up next month?',
  },
  {
    id: 19,
    category: 'delay_traveling',
    contactName: 'Maria Lopez',
    companyName: 'Plaid',
    subject: 'Re: product prioritization at Plaid',
    body: "I'm traveling for the next two weeks. Let's connect when I'm back!",
  },
  {
    id: 20,
    category: 'delay_busy_positive',
    contactName: 'David Park',
    companyName: 'Segment',
    subject: 'Re: product prioritization at Segment',
    body: "Interested but crazy busy right now. Can we reconnect in a few weeks?",
  },

  // DECLINE
  {
    id: 21,
    category: 'decline_polite',
    contactName: 'Sarah Johnson',
    companyName: 'Databricks',
    subject: 'Re: product prioritization at Databricks',
    body: "Thanks for reaching out but I don't think I'm the right fit for this. Good luck!",
  },
  {
    id: 22,
    category: 'decline_no_time',
    contactName: 'Mike Brown',
    companyName: 'Snowflake',
    subject: 'Re: product prioritization at Snowflake',
    body: "Sorry, I really don't have bandwidth for calls right now.",
  },

  // COLLEGE STUDENT SPECIFIC EDGE CASES
  {
    id: 23,
    category: 'edge_job_seeking',
    contactName: 'Alex Turner',
    companyName: 'Airbnb',
    subject: 'Re: product prioritization at Airbnb',
    body: "Are you guys looking for interns or jobs? I'm graduating soon!",
  },
  {
    id: 24,
    category: 'edge_job_question',
    contactName: 'Jordan Lee',
    companyName: 'Lyft',
    subject: 'Re: product prioritization at Lyft',
    body: 'Is this some kind of job application? Are you guys hiring?',
  },
  {
    id: 25,
    category: 'edge_sales_pitch',
    contactName: 'Nicole Adams',
    companyName: 'Uber',
    subject: 'Re: product prioritization at Uber',
    body: 'Is this a sales pitch? What are you trying to sell me?',
  },
  {
    id: 26,
    category: 'edge_skeptical',
    contactName: 'Brian Wilson',
    companyName: 'DoorDash',
    subject: 'Re: product prioritization at DoorDash',
    body: 'How did you get my email? This seems like spam.',
  },
  {
    id: 27,
    category: 'edge_class_project',
    contactName: 'Katie Smith',
    companyName: 'Instacart',
    subject: 'Re: product prioritization at Instacart',
    body: 'Is this for a class project or something?',
  },
  {
    id: 28,
    category: 'edge_sarcastic',
    contactName: 'Tyler Johnson',
    companyName: 'Robinhood',
    subject: 'Re: product prioritization at Robinhood',
    body: 'lol product prioritization huh? Sure why not',
  },

  // REFERRALS
  {
    id: 29,
    category: 'referral_with_contact',
    contactName: 'Jennifer Wu',
    companyName: 'Coinbase',
    subject: 'Re: product prioritization at Coinbase',
    body: "I'm not the right person for this. Try reaching out to our PM lead, David Chen - david@coinbase.com",
  },
  {
    id: 30,
    category: 'referral_vague',
    contactName: 'Steve Miller',
    companyName: 'Square',
    subject: 'Re: product prioritization at Square',
    body: "You've got the wrong person. Maybe try someone on the product team?",
  },

  // CALENDLY SENT
  {
    id: 31,
    category: 'calendly_sent',
    contactName: 'Amy Chang',
    companyName: 'Asana',
    subject: 'Re: product prioritization at Asana',
    body: 'Sure! Book some time here: https://calendly.com/amychang/30min',
  },

  // TECHNICAL/COMPLIANCE QUESTIONS
  {
    id: 32,
    category: 'question_what_tool',
    contactName: 'Michael Roberts',
    companyName: 'Okta',
    subject: 'Re: product prioritization at Okta',
    body: 'What exactly is the tool? Does it integrate with Jira?',
  },
  {
    id: 33,
    category: 'question_pricing',
    contactName: 'Lauren Taylor',
    companyName: 'Twilio',
    subject: 'Re: product prioritization at Twilio',
    body: 'How much does it cost?',
  },

  // SHORT/AMBIGUOUS
  {
    id: 34,
    category: 'short_reply_positive',
    contactName: 'Nick Brown',
    companyName: 'Zapier',
    subject: 'Re: product prioritization at Zapier',
    body: 'Sure',
  },
  {
    id: 35,
    category: 'short_reply_ambiguous',
    contactName: 'Sara Lee',
    companyName: 'Airtable',
    subject: 'Re: product prioritization at Airtable',
    body: 'Maybe',
  },
];

async function runTests(): Promise<void> {
  const results: TestResult[] = [];

  console.log('Starting auto-reply pipeline tests v2 (startups focus)...\n');
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
  fs.writeFileSync('auto-reply-test-report-v2.md', report);
  console.log('Report written to auto-reply-test-report-v2.md');
}

function generateReport(results: TestResult[]): string {
  const sendCount = results.filter(r => r.final_action === 'SEND').length;
  const founderCount = results.filter(r => r.final_action === 'FOUNDER').length;
  const skipCount = results.filter(r => r.final_action === 'SKIP').length;

  let report = `# Auto-Reply Pipeline Test Report v2

**Focus:** Startups, college student context, product validation framing

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
