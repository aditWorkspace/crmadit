// Pure function: renders a subject + body from a template variant and
// recipient context. See spec §7 for the full template authoring model.
//
// Supported merge tags (case-sensitive, whitespace-tolerant):
//   {{first_name}}   — falls back to "there"
//   {{company}}      — falls back to "your company"
//   {{founder_name}} — sending founder's first name (always set)
//
// Spintax (greetings/sign-offs only, author-marked):
//   {{ RANDOM | option_a | option_b | option_c }}
// Whitespace around the pipes and inside options is normalized.
//
// IMPORTANT: NO unsubscribe footer is auto-injected. The recipient sees
// what looks like a 1:1 personal email. The List-Unsubscribe header
// (added by send.ts in PR 3) handles bulk-mail signaling invisibly.

export interface RenderTemplateInput {
  subject_template: string;
  body_template: string;
  first_name: string | null;
  company: string | null;
  founder_name: string;
}

export interface RenderTemplateResult {
  subject: string;
  body: string;
}

const SPINTAX_RE = /\{\{\s*RANDOM\s*\|([^}]+)\}\}/g;
const TAG_FIRST_NAME_RE = /\{\{\s*first_name\s*\}\}/g;
const TAG_COMPANY_RE = /\{\{\s*company\s*\}\}/g;
const TAG_FOUNDER_NAME_RE = /\{\{\s*founder_name\s*\}\}/g;

function resolveSpintax(input: string): string {
  return input.replace(SPINTAX_RE, (_, optionsStr: string) => {
    const choices = optionsStr.split('|').map((s: string) => s.trim()).filter(Boolean);
    if (choices.length === 0) return '';
    return choices[Math.floor(Math.random() * choices.length)];
  });
}

function substituteMergeTags(input: string, ctx: {
  first_name: string;
  company: string;
  founder_name: string;
}): string {
  return input
    .replace(TAG_FIRST_NAME_RE, ctx.first_name)
    .replace(TAG_COMPANY_RE, ctx.company)
    .replace(TAG_FOUNDER_NAME_RE, ctx.founder_name);
}

export function renderTemplate(input: RenderTemplateInput): RenderTemplateResult {
  const ctx = {
    first_name:   input.first_name?.trim()    || 'there',
    company:      input.company?.trim()       || 'your company',
    founder_name: input.founder_name,
  };

  const subject = substituteMergeTags(resolveSpintax(input.subject_template), ctx);
  const body    = substituteMergeTags(resolveSpintax(input.body_template), ctx);

  return { subject, body };
}
