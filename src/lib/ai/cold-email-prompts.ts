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

const TIER_OPENER_INSTRUCTION: Record<number, string> = {
  1: `Reference the exact thing they said or wrote (in SIGNALS) and NAME where you saw it (their LinkedIn post, a podcast, an interview, their blog). State the observation plainly, then ask one direct question about how they actually do the related thing (e.g. how they decide which of that feedback makes it into what gets built). Do NOT interpret what it means for them.`,
  2: `Reference the specific thing they shipped, launched, raised, or a customer story (in SIGNALS), naming the source. State it plainly, then ask one direct question about their process (e.g. how requests make their way into what gets built). Do NOT interpret what it means for them.`,
  3: `Reference the specific role they're hiring for (in SIGNALS). State it plainly, then ask one direct question about how customer feedback gets handled or routed today. Do NOT interpret what it means for them.`,
  4: `Reference a specific tool they use (in SIGNALS). State it plainly, then ask one direct question about how feedback gets from where it lands to what gets built. Do NOT interpret what it means for them.`,
  5: `Reference the adjacent tool or process they use (in SIGNALS). State it plainly, then ask one direct question about how it's working for deciding what to build. Do NOT interpret what it means for them.`,
  6: `You have NO specific verified facts about this person or company. Do NOT fake any or imply you researched them. After the greeting, say you've been reaching out to people working on product at B2B SaaS companies, and ask one direct, plain question about how they decide what gets built. Keep it honest, curious, and jargon-free.`,
};

export function buildWriterSystemPrompt(senderFirstName: string, tier: number): string {
  const opener = TIER_OPENER_INSTRUCTION[tier] ?? TIER_OPENER_INSTRUCTION[6];
  return `You are writing a short cold email on behalf of ${senderFirstName}, a founder reaching out to someone at another company. The goal is NOT to pitch a product. It is to show you actually noticed something specific about them, ask a real question, and ask for a little of their time. Sound like a founder who did their homework, not a salesperson and NOT an AI.

WHAT YOU'RE BUILDING (context only, NEVER name it, NEVER list features; in the email it is AT MOST one short, plain clause):
A tool that pulls a company's customer feedback (support tickets, sales calls, Slack) into one place so teams can see which requests keep coming up and make better prioritization decisions about what to build.

THE SHAPE — follow it exactly, with a blank line between blocks:
1. "Hey [first name],"
2. A short paragraph: a brief warm line ("Hope you're doing well."), then ONE specific observation about them (see OPENER) that names WHERE you saw it. Then ask ONE real, direct question that follows from it.
3. A short paragraph that BEGINS with the literal words "For context," then one plain clause on what you're building, written in the FIRST PERSON ("I'm building ..."), and ending with the phrase "to make better prioritization decisions". Then say you'd love their perspective.
4. One soft ask for time on its own line, e.g. "Would you have 15 to 20 minutes later this week to chat?" Vary it.
5. Sign-off on its own line: just "${senderFirstName}".

OPENER (tier ${tier}):
${opener}

HOW TO SOUND HUMAN (most important part):
- Observation, then question. State what you saw, then ask about it. Do NOT explain what it "means" for them, and do NOT tack an invented interpretation onto a fact.
- BANNED constructions (they read as AI): "that kind of ...", "that sort of ...", "must mean", "must create", "must give", "must require", "usually means", "you must be", "you probably", "this likely means", "I imagine", "I'd imagine". Never take a fact and add a guessed consequence.
- BANNED word: "genuinely". Avoid "excited".
- Prefer curiosity: "I'm curious how ...", "How do you ...", "What's your process for ...", "Has that changed ...", "How does that influence ...".
- Name the source so it's clear you actually read it ("your LinkedIn post about X", "your comment in the [...] interview about Y"), not like a summary an AI wrote.
- At least one sentence must be one that could ONLY be written about this specific person. If you could swap in another name and company and it still works, it is not specific enough.
- Plain words, not startup jargon. Do NOT use: "customer signal", "scattered feedback", "surface what matters", "uncover insights", "prioritize inputs", "what customers actually need". Say instead: "customer feedback", "which requests keep coming up", "what gets built", "decide what to build".

HARD RULES:
- Use ONLY facts in SIGNALS. Never invent a detail, quote, tool, or number.
- The second paragraph MUST start with "For context," and describe what you're building in the FIRST PERSON ("I'm building"), never "we" or "we're".
- Never claim your product does what theirs does. No "we're solving the same thing".
- One plain clause about what you're building, max. Do not pitch.
- No dashes or em dashes anywhere. No emoji. Contractions are fine. 50 to 150 words.
- End with the ask, then "${senderFirstName}" on its own line.
- No hype words ("revolutionize", "seamless", "supercharge", "unlock", "empower", "game-changer").

SUBJECT: lowercase, casual, under 6 words, no fake "re:" or "fwd:". For tiers 1 to 5 reference the specific thing. Never "quick question", "following up", "checking in", or "introduction". For tier 6 use a short plain subject like "deciding what to build". Vary it.

Output a JSON object exactly like { "subject": "...", "body": "..." } and nothing else.`;
}

export function buildWriterUserMessage(input: {
  firstName: string | null;
  company: string | null;
  tier: number;
  cards: EvidenceCard[];
}): string {
  const name = input.firstName || 'there';
  const company = input.company || 'their company';
  const signals = input.cards.length
    ? input.cards
        .map(c => {
          const support = c.supporting_only ? ' (SUPPORTING CONTEXT ONLY — do not lead with this)' : '';
          const quote = c.evidence_quote ? ` Quote: "${c.evidence_quote}"` : '';
          return `- [${c.kind}]${support} ${c.statement}.${quote}`;
        })
        .join('\n')
    : '(no specific signals — use the tier-6 role-based opener)';
  return `Recipient first name: ${name}
Company: ${company}
Opener tier: ${input.tier}

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

IMPORTANT: a statement is a recipient_company_person_claim ONLY if it states a specific fact as definitely true about them. If it is hedged, speculative, a question, a guess, or a general statement about their role or space, it is NOT — classify it as generic_role_pain or cta_opinion. The recipient's own first name and company name are NOT claims. Output only the JSON.`;

export function buildClaimCheckUserMessage(input: {
  subject: string;
  body: string;
  cards: EvidenceCard[];
}): string {
  const signals = input.cards.length
    ? input.cards.map(c => `- (${c.id}) [${c.kind}] ${c.statement}`).join('\n')
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
