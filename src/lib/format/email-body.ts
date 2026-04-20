/**
 * Single shared post-processor for every auto-sent email body.
 *
 * Takes arbitrary AI-generated prose and normalizes it to the canonical shape:
 *
 *   Hi <RecipientFirstName>,
 *
 *   <paragraph 1>
 *
 *   <paragraph 2>
 *
 *   Best,
 *   <SenderFirstName>
 *
 * Guarantees a blank line between every block, strips em/en dashes, drops
 * whatever greeting/signoff the model emitted, and reattaches the canonical
 * greeting + signoff. Idempotent — running twice produces the same output.
 */

export interface FormatOptions {
  recipientFirstName: string;
  senderFirstName: string;
}

// Matches any short greeting line the AI might have emitted despite the
// system prompt forbidding it, e.g. "Hi Shian,", "Hello there,", "Hey!".
// Requires a terminator (, ! . or newline) so we don't accidentally clip
// body sentences that happen to start with "hi".
const GREETING_PREFIX_RE = /^(hi|hey|hello)\b[^\n]*?[,!.]\s*/i;
const SIGNOFF_LINE_RE = /^(best|thanks|thank you|cheers|regards|sincerely|talk soon),?$/i;

export function formatEmailBody(raw: string, opts: FormatOptions): string {
  const recipient = (opts.recipientFirstName || 'there').trim();
  const sender = (opts.senderFirstName || 'Adit').trim();
  const senderLower = sender.toLowerCase();

  let s = raw.replace(/\r\n/g, '\n');

  s = s.replaceAll('—', ', ');
  s = s.replaceAll('–', ', ');
  s = s.replace(/\s+,/g, ',');
  s = s.replace(/[ \t]{2,}/g, ' ');

  const rawLines = s.split('\n');
  let cutIdx = rawLines.length;
  for (let i = rawLines.length - 1; i >= 0; i--) {
    if (SIGNOFF_LINE_RE.test(rawLines[i].trim())) {
      cutIdx = i;
      break;
    }
  }
  rawLines.length = cutIdx;

  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') {
    rawLines.pop();
  }
  if (rawLines.length > 0 && rawLines[rawLines.length - 1].trim().toLowerCase() === senderLower) {
    rawLines.pop();
  }
  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') {
    rawLines.pop();
  }

  s = rawLines.join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');

  // If writer returned no blank-line separators, promote sentence-terminated
  // line breaks to paragraph breaks so Gmail renders proper spacing.
  if (!s.includes('\n\n')) {
    s = s.replace(/([.?!])\n(?=\S)/g, '$1\n\n');
  }

  const blocks = s
    .split(/\n\s*\n+/)
    .map(b => b.trim())
    .filter(Boolean);

  if (blocks.length > 0) {
    blocks[0] = blocks[0].replace(GREETING_PREFIX_RE, '').trim();
    if (!blocks[0]) blocks.shift();
  }

  const body = blocks.join('\n\n');
  const greeting = `Hi ${recipient},`;
  const signoff = `Best,\n${sender}`;

  if (!body) return `${greeting}\n\n${signoff}`;
  return `${greeting}\n\n${body}\n\n${signoff}`;
}
