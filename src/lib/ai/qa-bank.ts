/**
 * Q&A knowledge bank for auto-responding to info_request classifications.
 *
 * Answers are short, written in Adit's voice, and deliberately non-pitchy.
 * The info-request writer blends at most 2 relevant entries into a 3-4
 * sentence reply. Entries are matched via cheap keyword triggers — no
 * embeddings — so picking is deterministic and free.
 */

export interface QaItem {
  id: string;
  triggers: string[]; // lowercase substrings checked against the inbound body
  answer: string;
}

export const QA_BANK: QaItem[] = [
  {
    id: 'what_is_proxi',
    triggers: [
      'what is proxi',
      'what does proxi do',
      'what are you building',
      'tell me more',
      'more info',
      "what's proxi",
      'what is it',
    ],
    answer:
      "We're a few Berkeley students building what's essentially a command center for PMs, think one place for feedback, prioritization, and roadmap. Still early, which is why we're trying to learn from operators like you before we lock the shape.",
  },
  {
    id: 'problem',
    triggers: ['what problem', 'what pain', 'why are you', 'who is it for'],
    answer:
      "The rough hypothesis is that PMs juggle too many tools to figure out what to build next. We think a single pane from customer signal to launched feature could save a lot of tab-switching, but we'd rather hear how you think about it than pitch ours.",
  },
  {
    id: 'features',
    triggers: ['what features', 'functionality', 'capabilities'],
    answer:
      "Intentionally being quiet on specifics right now, we're still pruning the feature list down to what people actually need. That's part of why we wanted to talk.",
  },
  {
    id: 'launch',
    triggers: ['when launch', 'launch date', 'ga', 'available', 'timeline', 'go live'],
    answer:
      "No public launch date yet, we're in the design-partner phase. If the conversation goes well we'd love to get you early access.",
  },
  {
    id: 'demo',
    triggers: ['demo', 'screenshot', 'see it', 'can i try', 'walkthrough'],
    answer:
      "Happy to walk you through what we have on a quick call, it's easier to show than to describe in email.",
  },
  {
    id: 'team',
    triggers: ['who are you', 'team', 'founders', 'about you', 'background'],
    answer:
      'Berkeley co-founders Adit and Asim — CS and business. This is our primary project.',
  },
  {
    id: 'funding',
    triggers: ['funding', 'funded', 'raise', 'investors', 'vc', 'backed'],
    answer:
      'Self-funded right now. Focused on user conversations before thinking about a round.',
  },
  {
    id: 'pricing',
    triggers: ['pricing', 'cost', 'price', 'how much', 'free', 'paid'],
    answer:
      'Pricing is not finalized. Early design partners will likely get extended free access.',
  },
  {
    id: 'integrations',
    triggers: [
      'integrat',
      'connect',
      'jira',
      'linear',
      'slack',
      'salesforce',
      'hubspot',
      'notion',
      'figma',
    ],
    answer:
      'Still mapping the integration list to what PMs actually depend on day to day, would love to know what would matter most in your stack.',
  },
  {
    id: 'security',
    triggers: [
      'secur',
      'privacy',
      'data',
      'soc 2',
      'gdpr',
      'hipaa',
      'compliance',
      'store',
    ],
    answer:
      "Data stays in your account, we don't train on or share it, and we'll have a security review ready before any paid customer goes live. For deeper compliance questions I'd pull in my co-founders on a call.",
  },
  {
    id: 'customers',
    triggers: ['who uses', 'customers', 'users', 'case study', 'references'],
    answer:
      "We're pre-launch, so we're not naming anyone yet. Can share more about the design-partner cohort on a call.",
  },
  {
    id: 'competitors',
    triggers: [
      'productboard',
      'aha',
      'jira product',
      'roadmunk',
      'canny',
      'savio',
      'compete',
      'compared to',
      'versus',
      'vs ',
    ],
    answer:
      "We've looked at them and think there's real room on the feedback-to-decision path, but we don't want to anchor you on our angle before hearing yours.",
  },
  {
    id: 'why_me',
    triggers: ['why reach out', 'why me', 'how did you find'],
    answer:
      "You're senior on the product side at a company we admire, and the way you think about prioritization is exactly the input that would shape what we build.",
  },
  {
    id: 'differentiator',
    triggers: ['different', 'unique', 'differentiator', 'angle', 'moat'],
    answer:
      "Honestly we'd rather not anchor you on our angle before you share yours, it skews the conversation. Happy to trade notes on a call.",
  },
  {
    id: 'location',
    triggers: ['based', 'location', 'where', 'hq', 'office', 'remote'],
    answer: 'Based in Berkeley, California.',
  },
  {
    id: 'hiring',
    triggers: ['hiring', 'jobs', 'careers', 'join', 'work with'],
    answer:
      'Not hiring formally right now, but always open to chat if it could be a fit down the line.',
  },
  {
    id: 'invest',
    triggers: ['invest', 'check', 'cap table', 'round'],
    answer:
      'Not raising at the moment, appreciate the interest though. Happy to keep in touch.',
  },
  {
    id: 'ai',
    triggers: ['ai', 'llm', 'gpt', 'claude', 'machine learning', 'model'],
    answer:
      'Yes, AI is in the loop for a few pieces. Happy to go deeper on where it helps and where we deliberately kept humans in on a call.',
  },
  {
    id: 'one_liner',
    triggers: ['one line', 'tldr', 'summary', 'elevator', 'short version'],
    answer:
      'A command center for product managers, one place from customer signal to what ships next.',
  },
  {
    id: 'next_step',
    triggers: ['next step', 'how do i', 'how to', 'what now', 'proceed'],
    answer: "The easiest next step is a quick call, I'll send a link.",
  },
];

/**
 * Pick up to `max` Q&A items whose triggers appear in the inbound body.
 * Entries with more trigger hits rank first. Deterministic — same input
 * always returns the same entries in the same order.
 */
export function pickRelevantQa(inboundBody: string, max = 3): QaItem[] {
  const lower = inboundBody.toLowerCase();
  const scored = QA_BANK.map((q) => ({
    q,
    score: q.triggers.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((s) => s.score > 0)
    .slice(0, max)
    .map((s) => s.q);
}
