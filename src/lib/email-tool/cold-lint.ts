// Deterministic copy linter for personalized cold emails. Runs BEFORE the
// LLM claim-check (cheap, no tokens). A single blocker fails the draft text;
// warnings are advisory. Scope is intentionally the fixed list of mechanical
// rules — semantic checks (one CTA, no fabrication) live in the writer prompt
// and the claim-check pass.

import {
  BODY_MIN_WORDS,
  BODY_MAX_WORDS,
  SUBJECT_MAX_WORDS,
  FORBIDDEN_PHRASES,
  DECEPTIVE_SUBJECT_PREFIXES,
} from './cold-constants';

export interface LintIssue {
  code: string;
  severity: 'blocker' | 'warning';
  message: string;
}

export interface LintResult {
  ok: boolean; // false if any blocker
  issues: LintIssue[];
}

const DASH_RE = /[–—―]/;          // en / em / horizontal-bar
const MERGE_TAG_RE = /\{\{.*?\}\}/;
const URL_RE = /(https?:\/\/|www\.)/i;
const BARE_DOMAIN_RE = /\b[a-z0-9][a-z0-9-]*\.(com|io|ai|dev|co|app|net|org|xyz|so)\b/i;
const CITATION_RE = /\[\d+\]/;
// Extended_Pictographic covers emoji without flagging arrows/dashes/quotes.
const EMOJI_RE = /\p{Extended_Pictographic}/u;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function lintColdEmail(subject: string, body: string): LintResult {
  const issues: LintIssue[] = [];
  const add = (code: string, severity: LintIssue['severity'], message: string) =>
    issues.push({ code, severity, message });

  const subjLower = subject.toLowerCase();
  const bodyLower = body.toLowerCase();

  // ── Length ───────────────────────────────────────────────────────────────
  const bw = wordCount(body);
  if (bw < BODY_MIN_WORDS) add('body_too_short', 'blocker', `body is ${bw} words, min ${BODY_MIN_WORDS}`);
  if (bw > BODY_MAX_WORDS) add('body_too_long', 'blocker', `body is ${bw} words, max ${BODY_MAX_WORDS}`);
  const sw = wordCount(subject);
  if (sw === 0) add('subject_empty', 'blocker', 'subject is empty');
  if (sw >= SUBJECT_MAX_WORDS) add('subject_too_long', 'blocker', `subject is ${sw} words, must be under ${SUBJECT_MAX_WORDS}`);

  // ── Subject format ───────────────────────────────────────────────────────
  if (/[A-Z]/.test(subject)) add('subject_not_lowercase', 'blocker', 'subject must be lowercase');
  if (DECEPTIVE_SUBJECT_PREFIXES.some(p => subjLower.trimStart().startsWith(p))) {
    add('deceptive_subject', 'blocker', 'subject fakes a reply/forward (re:/fwd:)');
  }

  // ── Dashes ───────────────────────────────────────────────────────────────
  if (DASH_RE.test(subject) || DASH_RE.test(body)) add('dashes', 'blocker', 'contains em/en dash');

  // ── Merge tags ───────────────────────────────────────────────────────────
  if (MERGE_TAG_RE.test(subject) || MERGE_TAG_RE.test(body)) add('merge_tags', 'blocker', 'contains an unsubstituted {{merge tag}}');

  // ── URLs / citations ─────────────────────────────────────────────────────
  if (URL_RE.test(subject) || URL_RE.test(body) || BARE_DOMAIN_RE.test(body) || CITATION_RE.test(body)) {
    add('urls', 'blocker', 'contains a URL or citation');
  }

  // ── Emoji ────────────────────────────────────────────────────────────────
  if (EMOJI_RE.test(subject) || EMOJI_RE.test(body)) add('emoji', 'blocker', 'contains emoji');

  // ── Forbidden / hype phrases ─────────────────────────────────────────────
  for (const phrase of FORBIDDEN_PHRASES) {
    if (subjLower.includes(phrase) || bodyLower.includes(phrase)) {
      add('forbidden_phrase', 'blocker', `contains forbidden phrase "${phrase}"`);
    }
  }

  return { ok: !issues.some(i => i.severity === 'blocker'), issues };
}
