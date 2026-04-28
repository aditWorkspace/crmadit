// Shared helpers for working with email addresses on leads & contacts.
//
// These exist as private duplicates inside `auto-create.ts` and
// `calendar-sync.ts` from earlier work. Keeping those duplicates rather
// than refactoring them — both have shipped and changing them is a
// blast-radius risk we don't need today. New code uses this module.

export const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'live.com', 'msn.com', 'protonmail.com',
  'protonmail.ch', 'pm.me', 'hey.com', 'fastmail.com',
]);

// Role-based / non-human addresses we never want stored as lead contacts.
const NON_HUMAN_LOCALPARTS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'bounces', 'bounce',
  'notifications', 'notification', 'auto-confirm',
]);

const NON_HUMAN_DOMAINS = new Set([
  'mail.granola.ai',
  'notifications.zcal.co',
  'zcal.co',
  'calendar-notification.google.com',
  'google.com',
]);

export function isLikelyHumanEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!e.includes('@')) return false;
  const [local, domain] = e.split('@');
  if (!local || !domain) return false;
  if (NON_HUMAN_LOCALPARTS.has(local)) return false;
  if (NON_HUMAN_DOMAINS.has(domain)) return false;
  // Catch any "*@noreply.*" or "noreply+anything@*" style.
  if (/^no[-_.]?reply/i.test(local)) return false;
  if (domain.startsWith('noreply.')) return false;
  return true;
}

export function companyFromDomain(email: string): string | null {
  const domain = email.toLowerCase().split('@')[1];
  if (!domain || PERSONAL_DOMAINS.has(domain)) return null;
  const parts = domain.split('.');
  const slug = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

export function nameFromEmail(email: string): string {
  const local = email.split('@')[0];
  return local
    .replace(/[._+-]+/g, ' ')
    .replace(/\d+/g, '')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || email;
}

export interface AddressEntry {
  name: string | null;
  email: string;
}

// Parses an RFC 5322 address-list header value. Handles:
//   "Foo Bar" <a@b.com>, c@d.com, =?utf-8?q?...?= <e@f.com>
// We don't decode RFC 2047 names — those are rare in our flow and the
// fallback (nameFromEmail) is fine when the encoded form survives.
export function parseAddressList(headerValue: string): AddressEntry[] {
  if (!headerValue) return [];
  const out: AddressEntry[] = [];
  // Split on commas not inside quotes or angle brackets.
  let depth = 0;
  let inQuote = false;
  let buf = '';
  const chunks: string[] = [];
  for (const ch of headerValue) {
    if (ch === '"' && !inQuote) inQuote = true;
    else if (ch === '"' && inQuote) inQuote = false;
    else if (!inQuote && ch === '<') depth++;
    else if (!inQuote && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0 && !inQuote) {
      if (buf.trim()) chunks.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  for (const chunk of chunks) {
    const angled = chunk.match(/^(.*?)<([^>]+)>\s*$/);
    if (angled) {
      const name = angled[1].trim().replace(/^"|"$/g, '').trim();
      const email = angled[2].trim().toLowerCase();
      if (email.includes('@')) out.push({ name: name || null, email });
    } else if (chunk.includes('@')) {
      out.push({ name: null, email: chunk.trim().toLowerCase() });
    }
  }
  return out;
}
