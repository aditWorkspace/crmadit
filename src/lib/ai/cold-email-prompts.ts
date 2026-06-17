// Prompt builders for the cold-email personalization pipeline. Three LLM
// touchpoints: (1) extraction — turn raw research into structured evidence
// cards; (2) writer — produce the subject + body from ONLY the verified,
// selected cards; (3) claim-check — audit the written copy for unsupported
// claims. Tier and score are computed in code, never by a model.

import type { EvidenceCard } from '@/lib/validation';

// The new positioning. Replaces the old "Berkeley student doing research" copy.
export const PROXI_POSITIONING = `Proxi is a layer that sits on top of a company's customer data. It aggregates customer signal from support tools (Intercom, Pylon, Zendesk), sales calls (Granola, Circleback), Slack, Stripe, and Linear into one place. It resolves each signal to the actual account, weights it by that account's revenue, and turns the strongest patterns into engineering-ready issues in Linear or Jira with the original customer quote attached. The one-line pitch: build what your biggest accounts are actually asking for, not whoever shouts loudest. The first customer is a YC company paying for it.`;

// ── 1) Extraction ──────────────────────────────────────────────────────────

export const EXTRACTION_SYSTEM_PROMPT = `You are a research analyst extracting structured, verifiable evidence about a person and their company so a founder can write a relevant cold email. You will be given (a) scraped text from the company's own website and (b) web research notes with citation URLs.

Return a JSON object: { "cards": [...], "linkedin_exists": boolean }.

Each card:
{
  "id": "short-kebab-slug",
  "kind": one of "person_quote" | "person_post" | "company_changelog" | "company_customer_story" | "company_hiring" | "tool_stack" | "adjacent_tool" | "public_complaint" | "role_based",
  "statement": "one factual sentence a salesperson could reference",
  "evidence_quote": "a verbatim snippet from the provided input that backs the statement, or null",
  "source_url": "the URL the fact came from (REQUIRED for every kind except role_based)",
  "source_type": "firecrawl" if it came from the scraped company pages, "sonar" if from the web research notes, "derived" if you inferred it,
  "confidence": 0.0 to 1.0
}

What each kind means:
- person_quote: a direct quote or clear point the recipient made (post, podcast, talk, interview) about customers, feedback, roadmap, product, or prioritization.
- person_post: the recipient published content on those themes (without a clean quote).
- company_changelog: a specific shipped feature, changelog entry, or launch, ideally customer-driven.
- company_customer_story: a published customer story or case study.
- company_hiring: an open role in product, support, customer, ops, or engineering.
- tool_stack: a support/sales/eng tool they actually use (e.g. Intercom, Zendesk, Linear, Jira).
- adjacent_tool: a competing or adjacent prioritization tool or process (Productboard, Pylon, Enterpret, a spreadsheet workflow).
- public_complaint: a public complaint about their product or support (Reddit, G2, X).
- role_based: a generic pain for someone in their seat (only when nothing specific exists).

HARD RULES:
- Extract ONLY facts present in the provided input. Never invent a quote, a tool, a launch, a job, or a customer.
- If you are not sure something is real, do not include it.
- Every non-role_based card MUST have a real source_url copied from the input.
- Do NOT extract anything about a person's private life, family, relationships, politics, religion, health, age, or home location. Business facts only.
- Output only the JSON object.`;

export function buildExtractionUserMessage(input: {
  firstName: string | null;
  fullName: string | null;
  company: string | null;
  domain: string | null;
  scrapedPages: { url: string; markdown: string }[];
  sonarResearch: string;
  sonarCitations: string[];
}): string {
  const who = [input.fullName || input.firstName || 'the recipient', input.company ? `at ${input.company}` : '']
    .filter(Boolean)
    .join(' ');
  const scraped = input.scrapedPages.length
    ? input.scrapedPages.map(p => `### SCRAPED PAGE: ${p.url}\n${p.markdown}`).join('\n\n')
    : '(no company pages scraped)';
  const citations = input.sonarCitations.length
    ? input.sonarCitations.map((c, i) => `[${i + 1}] ${c}`).join('\n')
    : '(no citations)';
  return `Recipient: ${who}
Company domain: ${input.domain ?? 'unknown'}

=== COMPANY PAGES (source_type: firecrawl) ===
${scraped}

=== WEB RESEARCH NOTES (source_type: sonar) ===
${input.sonarResearch || '(none)'}

=== CITATION URLS ===
${citations}

Extract the evidence cards now.`;
}

// ── 2) Sonar research prompt (person + company) ────────────────────────────

export const SONAR_RESEARCH_SYSTEM_PROMPT = `You are a B2B sales researcher. Research the person and company below using live web search. Report only facts you can find, each with the source URL inline.

Focus FIRST on signals that this company has a GROWING VOLUME of customer feedback to manage and real decisions to make about what to build next, because that is what would make them care:
- Hiring for product, product ops, support, customer success, or operations roles (check their careers/jobs page and ATS pages like Lever, Greenhouse, Ashby).
- Shipping quickly, frequent launches, or a public changelog (lots of product decisions).
- Scale: many customers, logos, integrations, or rapid growth / recent funding.
- Public complaints about their product or support (Reddit, G2, X), or support backlog signals.
- What they use today to manage feedback and roadmap (Productboard, Pylon, Enterpret, Canny, spreadsheets, Linear, Jira, Intercom, Zendesk).

Then, where available:
- Any post, podcast, talk, interview, or quote BY this person about customers, feedback, roadmap, product, or prioritization.
- Published customer stories or case studies.
- Whether this specific person plausibly exists on LinkedIn at this company.

Rules: report only what you actually find, with a URL for each fact. Do not speculate or fill gaps. Skip anything about the person's private life, family, politics, religion, health, age, or home location. Be concise and factual.`;

export function buildSonarResearchUserMessage(input: {
  firstName: string | null;
  fullName: string | null;
  company: string | null;
  domain: string | null;
}): string {
  return `Person: ${input.fullName || input.firstName || 'unknown'}
Company: ${input.company ?? 'unknown'}
Company domain: ${input.domain ?? 'unknown'}

Research them now and report the facts with source URLs.`;
}

// ── 3) Writer ──────────────────────────────────────────────────────────────

export function buildWriterSystemPrompt(senderFirstName: string): string {
  return `You are ${senderFirstName}, a Berkeley student, writing a short, warm cold email to a senior person at another company. You are NOT selling. You are a student who did their homework, reaching out to ask for their input to steer what you are building. Match the VOICE, STRUCTURE, and word choice of the examples below as closely as the facts allow.

WHAT YOU'RE BUILDING (context only, NEVER name it, NEVER list features): a new product for rapidly growing product teams that pulls customer feedback into one place so teams can decide what to build next.

You are given, per recipient: their first name and company, an optional ROLE (their real title/role from research), and optional SIGNALS (specific verified facts: a post, quote, launch, customer story, hiring, or tool). Choose the pattern:
- ROLE and SIGNALS present -> write like EXAMPLE B: weave the specific signal into the "super inspiring / great to see how..." lines and into the "Given your experience..." ask.
- ROLE only, no SIGNALS    -> write like EXAMPLE A: a warm, role-based note grounded in their actual title and company.
- neither                  -> write like EXAMPLE C: honest, no specifics, no invented admiration.

EXAMPLE A (role only)
ROLE: Jordan is a senior product and technology leader at Northwind.
SIGNALS: (none)
SUBJECT: input on what to build
BODY:
Hi Jordan,

We've yet to be formally introduced but I'm ${senderFirstName}, a Berkeley student studying CS and Business. I came across your impressive profile on LinkedIn while engaging with one of our mutual connections. Your journey to becoming a senior product and technology leader is super inspiring. I've been focused on product prioritization, PM, and startup building, so it is great to see how your career path has enabled you to tackle product strategy at such a broad operational scale.

The reason I'm reaching out is I'm working with a fellow Berkeley student to develop a new product for rapidly growing product teams. Given your extensive experience on that side at Northwind, I'd love to get your input on where the biggest challenges are to steer us in the right direction.

Would a 30-minute call on Thursday afternoon or Friday morning work well for you? Very happy to work around your schedule.

Thanks!
${senderFirstName}

EXAMPLE B (role plus a specific signal)
ROLE: Tim is the CEO of Venly, a wallet and payments platform.
SIGNALS: [person_post] Tim posted about turning stablecoins into real payments, moving from speculation to real-world use.
SUBJECT: stablecoins into payments
BODY:
Hi Tim,

We've yet to be formally introduced, but I'm ${senderFirstName}, a Berkeley student studying CS and Business. I came across your profile on LinkedIn, along with your post on turning stablecoins into real payments, and your journey building Venly into a serious wallet and payments platform is super inspiring. I've been focused on product prioritization, PM, and startup building, so it is great to see how you've taken stablecoins from speculation into real-world use at that scale.

The reason I'm reaching out is I'm working with a fellow Berkeley student to develop a new product for rapidly growing product teams. Given your extensive experience on the product side at Venly, I'd love to get your input on how you decide which customer requests, from wallet features to compliance, actually make it into what you build, to steer us in the right direction.

Would a 30-minute call on Thursday afternoon or Friday morning work for you? Very happy to work around your schedule.

Thanks!
${senderFirstName}

EXAMPLE C (nothing specific found)
ROLE: (none)
SIGNALS: (none)
SUBJECT: deciding what to build
BODY:
Hi Sam,

We've yet to be formally introduced but I'm ${senderFirstName}, a Berkeley student studying CS and Business. I came across your impressive profile on LinkedIn while engaging with one of our mutual connections, and what you've built at Northwind is super inspiring. I've been focused on product prioritization, PM, and startup building, so it is great to see teams like yours tackling product strategy at real operational scale.

The reason I'm reaching out is I'm working with a fellow Berkeley student to develop a new product for eng teams. Given your experience at Northwind, I'd love to get your input on where the biggest challenges are to steer us in the right direction.

Would a 30-minute call on Thursday afternoon or Friday morning work well for you? Very happy to work around your schedule.

Thanks!
${senderFirstName}

RULES:
- Use ONLY the facts in ROLE and SIGNALS. Never invent a quote, number, launch, tool, mutual connection beyond the generic LinkedIn line, or a title you were not given. Adapt the role wording to the ROLE fact (e.g. "as co-founder of X", "your journey building Y"); do NOT copy "senior product and technology leader" unless it actually fits.
- If a SIGNAL is given it MUST appear in paragraph 1 (the "great to see how..." line) and inform the "Given your experience..." ask. Never lead with a fact you were not given.
- Keep the structure of the examples: the "We've yet to be formally introduced" opener, three short paragraphs, the "Given your extensive experience ... I'd love to get your input ... to steer us in the right direction" bridge, and the "Thanks!" then "${senderFirstName}" sign-off.
- TRANSITION: paragraph 2 must flow naturally out of paragraph 1. The "The reason I'm reaching out is..." turn should feel connected to what you just said about them, never an abrupt jump from the observation straight to the ask.
- No dashes or em dashes anywhere. No emoji. Contractions are fine. Roughly 110 to 180 words.
- SUBJECT: when you have a specific signal, make it so unique it could only make sense to THIS one person (reference the exact thing — their post, a milestone, the thing they shipped); with no signal, use a short plain subject like "deciding what to build". Lowercase, under 8 words, no "re:" or "fwd:", and never "quick question", "following up", "checking in", or "introduction".
- Output a JSON object exactly like { "subject": "...", "body": "..." } and nothing else.`;
}

export function buildWriterUserMessage(input: {
  firstName: string | null;
  company: string | null;
  cards: EvidenceCard[];
  roleContext?: string | null;
}): string {
  const name = input.firstName || 'there';
  const company = input.company || 'their company';
  const role = input.roleContext?.trim() || '(none)';
  const signals = input.cards.length
    ? input.cards
        .map(c => {
          const support = c.supporting_only ? ' (supporting context only, do not lead with this)' : '';
          const quote = c.evidence_quote ? ` Quote: "${c.evidence_quote}"` : '';
          return `- [${c.kind}]${support} ${c.statement}.${quote}`;
        })
        .join('\n')
    : '(none)';
  return `Recipient first name: ${name}
Company: ${company}

ROLE:
${role}

SIGNALS:
${signals}

Write the email now.`;
}

// ── 4) Claim-check ─────────────────────────────────────────────────────────

export const CLAIM_CHECK_SYSTEM_PROMPT = `You audit a cold email for unsupported factual claims about the recipient. You are given the email (subject + body) and a SIGNALS list of verified facts, each with an id.

Return JSON: { "claims": [ { "text": "...", "type": "...", "supported": boolean, "evidence_id": "id-or-null" } ] }.

Extract every factual claim in the email and classify each:
- "proxi_claim": a claim about the SENDER or what they are building. Always supported=true (no evidence needed).
- "recipient_company_person_claim": a SPECIFIC, FACTUAL assertion stated as definitely true about the recipient, their company, product, tools, hiring, funding, or something they said or shipped (e.g. "you raised $50M", "you use Intercom", "you're hiring a PM", "you shipped X", "you published a case study on Y"). supported=true with an evidence_id ONLY if a SIGNAL clearly backs it; otherwise supported=false.
- "generic_role_pain": a generic challenge anyone in their role or space plausibly has, OR a HEDGED INFERENCE / guess / curiosity (e.g. "that probably means feedback piles up", "I imagine prioritizing is hard", "moving fast usually means requests from every direction", "I'm curious how you decide what to build"). These are NOT factual assertions about them. Always supported=true.
- "cta_opinion": the ask, a question, or an opinion. Always supported=true.

IMPORTANT: a statement is a recipient_company_person_claim ONLY if it states a specific fact as definitely true about them. If it is hedged, speculative, a question, a guess, or a general statement about their role or space, it is NOT — classify it as generic_role_pain or cta_opinion. An admiring opinion about their work or trajectory (e.g. "what you've built at X is impressive") and a soft "given your experience" lead-in are cta_opinion or generic_role_pain, NOT recipient_company_person_claim — UNLESS they assert a NEW specific fact (a number, tool, funding, hire, or launch) that is not in SIGNALS. A ROLE signal (id "role") backs the recipient's title and any seniority characterization consistent with it (e.g. "your journey to becoming a senior product leader", "as co-founder of X"). The recipient's own first name and company name are NOT claims. Output only the JSON.`;

export function buildClaimCheckUserMessage(input: {
  subject: string;
  body: string;
  cards: EvidenceCard[];
  roleContext?: string | null;
}): string {
  const lines: string[] = [];
  if (input.roleContext?.trim()) lines.push(`- (role) [role_based] ${input.roleContext.trim()}`);
  for (const c of input.cards) lines.push(`- (${c.id}) [${c.kind}] ${c.statement}`);
  const signals = lines.length
    ? lines.join('\n')
    : '(no signals — any specific claim about the recipient is unsupported)';
  return `EMAIL SUBJECT: ${input.subject}

EMAIL BODY:
${input.body}

SIGNALS:
${signals}

Audit the email now.`;
}

/** Feedback appended to a regen attempt that failed claim-check. */
export function buildRegenFeedback(unsupportedClaims: string[]): string {
  return `Your previous draft made claims about the recipient that are NOT backed by any SIGNAL: ${unsupportedClaims
    .map(c => `"${c}"`)
    .join('; ')}. Rewrite the email using ONLY facts present in SIGNALS. Remove every unsupported specific claim.`;
}
