// LLM claim-check: the primary anti-fabrication gate given there's no human
// review. Extracts every factual claim from the written email and verifies
// that each claim ABOUT THE RECIPIENT maps to a selected evidence card.
//
// Provider errors (callAI throws) propagate to the engine, which maps them to
// a retry — a transient AI blip must never be mistaken for "email is clean".
// Only an unparseable auditor response fails closed (ok:false) so the engine
// regenerates / downgrades rather than shipping unaudited copy.

import { callAIMessages } from './openrouter';
import { COLD_RESEARCH_MODEL, COLD_MODEL_FALLBACKS } from '@/lib/email-tool/cold-constants';
import { tolerantJsonParse } from './json';
import { claimCheckSchema, type EvidenceCard } from '@/lib/validation';
import { CLAIM_CHECK_SYSTEM_PROMPT, buildClaimCheckUserMessage } from './cold-email-prompts';

export interface ClaimCheckResult {
  ok: boolean;
  unsupportedClaims: string[];
}

export async function claimCheck(input: {
  subject: string;
  body: string;
  cards: EvidenceCard[];
}): Promise<ClaimCheckResult> {
  // Throws on provider failure → bubbles to the engine (retry path).
  const raw = await callAIMessages({
    model: COLD_RESEARCH_MODEL,
    fallbackModels: COLD_MODEL_FALLBACKS,
    jsonMode: true,
    timeoutMs: 45_000,
    messages: [
      { role: 'system', content: CLAIM_CHECK_SYSTEM_PROMPT },
      { role: 'user', content: buildClaimCheckUserMessage(input) },
    ],
  });

  let obj: unknown;
  try {
    obj = tolerantJsonParse(raw);
  } catch {
    return { ok: false, unsupportedClaims: ['claim_check_unparseable'] };
  }
  const parsed = claimCheckSchema.safeParse(obj);
  if (!parsed.success) {
    return { ok: false, unsupportedClaims: ['claim_check_unparseable'] };
  }

  const unsupported = parsed.data.claims
    .filter(c => c.type === 'recipient_company_person_claim' && !c.supported)
    .map(c => c.text);
  return { ok: unsupported.length === 0, unsupportedClaims: unsupported };
}
