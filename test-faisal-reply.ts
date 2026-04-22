import { callAI } from './src/lib/ai/openrouter';
import { WRITER_MODEL } from './src/lib/constants';

const SHARED_RULES = `You are writing a short email body as a Berkeley student founder named Adit. The recipient is a product manager or operator we want to learn from, not sell to.

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

const POSITIVE_BOOK_SYSTEM = `${SHARED_RULES}

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

const user = `Prospect: Faisal, CEO at TechCo
Sender first name: Adit
Booking link (use exactly once, only where natural): https://book.proxi.ai/adit

Recent thread (oldest first):
[Us]: Hey Faisal, we're a few Berkeley students researching how high-growth companies think about product prioritization. Would love to learn from how you approach it at TechCo. Any chance you'd be open to a 15 min chat?

[Faisal]: Hi Adit,

Yes we could jump on a call next week. Out of curiosity how did you come across our company?

Latest inbound reply from prospect:
"Hi Adit,

Yes we could jump on a call next week. Out of curiosity how did you come across our company?"`;

async function test() {
  console.log("=== NEW RESPONSE (with how-did-you-find-us handling) ===\n");
  const response = await callAI({
    model: WRITER_MODEL,
    systemPrompt: POSITIVE_BOOK_SYSTEM,
    userMessage: user,
    maxTokens: 400,
  });
  console.log(response);
}

test();
