// Pre-save validation for email_template_variants. See spec §7.5.
// Two severities: blockers (cannot save) and warnings (savable with confirm).
//
// Run on every keystroke in the templates UI for live feedback, and again
// on the server when the API receives a save request — clients can be
// bypassed but server-side enforcement is authoritative.

export interface LintInput {
  subject_template: string;
  body_template: string;
}

export interface LintIssue {
  code: string;
  severity: 'blocker' | 'warning';
  message: string;
}

export interface LintResult {
  blockers: LintIssue[];
  warnings: LintIssue[];
}

const URL_SHORTENERS = /\b(bit\.ly|tinyurl|t\.co|goo\.gl|tiny\.cc|ow\.ly|is\.gd|buff\.ly)\b/i;
// "STOP" must be a standalone word (uppercase or as a separate token).
// Lowercase "stop" inside another word should NOT trigger.
const FORBIDDEN_BODY_WORDS = /\b(unsubscribe|opt[-_ ]?out|STOP)\b/;
const SPAMMY_WORDS = /\b(free|winner|act now|limited time|guarantee|100%|\$\$\$)\b/i;
const NO_REPLY_RE = /\bno[-_ ]?reply\b|\bdo[-_ ]?not[-_ ]?reply\b/i;
const ALL_CAPS_RUN_6_PLUS = /[A-Z]{6,}/;

const MERGE_TAG_FIRST_NAME = /\{\{\s*first_name\s*\}\}/;
const MERGE_TAG_COMPANY    = /\{\{\s*company\s*\}\}/;

const MIN_BODY_CHARS = 30;
const MAX_BODY_CHARS = 800;
const MAX_SUBJECT_CHARS = 80;
const MAX_LINKS_BEFORE_WARNING = 2;

export function lintTemplate(input: LintInput): LintResult {
  const blockers: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  const body = input.body_template.trim();
  const subject = input.subject_template.trim();

  // ── Blockers ────────────────────────────────────────────────────────────
  if (URL_SHORTENERS.test(body)) {
    blockers.push({
      code: 'url_shortener',
      severity: 'blocker',
      message: 'URL shorteners (bit.ly, tinyurl, t.co, etc.) trigger spam filters.',
    });
  }
  if (FORBIDDEN_BODY_WORDS.test(body)) {
    blockers.push({
      code: 'forbidden_word_unsubscribe',
      severity: 'blocker',
      message: 'Body must not contain "unsubscribe", "STOP", or "opt-out". The List-Unsubscribe header handles this invisibly.',
    });
  }
  if (NO_REPLY_RE.test(subject)) {
    blockers.push({
      code: 'subject_noreply',
      severity: 'blocker',
      message: 'Subject must not contain "noreply" or "do-not-reply".',
    });
  }
  if (body.length < MIN_BODY_CHARS) {
    blockers.push({
      code: 'body_too_short',
      severity: 'blocker',
      message: `Body is ${body.length} chars (min ${MIN_BODY_CHARS}).`,
    });
  }
  if (body.length > MAX_BODY_CHARS) {
    blockers.push({
      code: 'body_too_long',
      severity: 'blocker',
      message: `Body is ${body.length} chars (max ${MAX_BODY_CHARS}).`,
    });
  }

  // ── Warnings ────────────────────────────────────────────────────────────
  const bodyHasFirstName = MERGE_TAG_FIRST_NAME.test(body);
  const bodyHasCompany = MERGE_TAG_COMPANY.test(body);
  if (!bodyHasFirstName && !bodyHasCompany) {
    warnings.push({
      code: 'no_personalization',
      severity: 'warning',
      message: 'Body uses neither {{first_name}} nor {{company}}. Cold outreach without personalization gets flagged.',
    });
  }

  const linkCount = (body.match(/https?:\/\//g) ?? []).length;
  if (linkCount > MAX_LINKS_BEFORE_WARNING) {
    warnings.push({
      code: 'too_many_links',
      severity: 'warning',
      message: `Body has ${linkCount} links (recommend ≤ ${MAX_LINKS_BEFORE_WARNING}).`,
    });
  }

  if (subject.length > MAX_SUBJECT_CHARS) {
    warnings.push({
      code: 'subject_too_long',
      severity: 'warning',
      message: `Subject is ${subject.length} chars (recommend ≤ ${MAX_SUBJECT_CHARS}).`,
    });
  }

  if (ALL_CAPS_RUN_6_PLUS.test(subject)) {
    warnings.push({
      code: 'subject_caps',
      severity: 'warning',
      message: 'Subject contains a run of 6+ consecutive caps — looks spammy.',
    });
  }

  if (SPAMMY_WORDS.test(body) || SPAMMY_WORDS.test(subject)) {
    warnings.push({
      code: 'spammy_words',
      severity: 'warning',
      message: 'Spam-flag words detected (free, winner, act now, limited time, guarantee, 100%, $$$).',
    });
  }

  return { blockers, warnings };
}
