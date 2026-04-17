import React from 'react';

export interface MentionMember {
  id: string;
  name: string;
}

/**
 * Regex matching an @mention at the start of the string or preceded by
 * whitespace / bracket / start-of-line. Name captured as word chars only
 * (no spaces). Our three founders are all single-word first names
 * (Adit / Srijay / Asim) so we intentionally keep this simple and do not
 * support quoted multi-word mentions.
 *
 *   "@Adit"                → match
 *   "hey @Srijay check"    → match
 *   "email adit@proxi.ai"  → no match (preceded by a letter)
 *   "@Adit!"               → match "Adit" (trailing punct excluded)
 */
const MENTION_RE = /(^|[\s(\[{>])@([A-Za-z][A-Za-z0-9_-]*)/g;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findMember(name: string, members: MentionMember[]): MentionMember | null {
  const lower = name.toLowerCase();
  return members.find((m) => m.name.toLowerCase() === lower) ?? null;
}

export interface ParseResult {
  html: string;
  mentioned_ids: string[];
}

export function parseMentions(body: string, members: MentionMember[]): ParseResult {
  const mentioned = new Set<string>();
  const parts: string[] = [];
  let lastIndex = 0;
  const re = new RegExp(MENTION_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(body)) !== null) {
    const [, boundary, name] = match;
    const fullStart = match.index;
    const nameStart = fullStart + boundary.length;
    const nameEnd = nameStart + 1 + name.length; // +1 for '@'

    const member = findMember(name, members);

    parts.push(escapeHtml(body.slice(lastIndex, nameStart)));

    if (member) {
      mentioned.add(member.id);
      parts.push(
        '<span class="mention" data-member-id="' +
          escapeHtml(member.id) +
          '">@' +
          escapeHtml(member.name) +
          '</span>'
      );
    } else {
      parts.push(escapeHtml(body.slice(nameStart, nameEnd)));
    }

    lastIndex = nameEnd;
  }

  parts.push(escapeHtml(body.slice(lastIndex)));

  return {
    html: parts.join(''),
    mentioned_ids: Array.from(mentioned),
  };
}

/**
 * React-safe renderer — returns React nodes interleaving plain text with
 * <span class="mention"> elements. Use this instead of dangerouslySetInnerHTML.
 */
export function renderMentionsReact(
  body: string,
  members: MentionMember[]
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = new RegExp(MENTION_RE.source, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = re.exec(body)) !== null) {
    const [, boundary, name] = match;
    const fullStart = match.index;
    const nameStart = fullStart + boundary.length;
    const nameEnd = nameStart + 1 + name.length;

    const member = findMember(name, members);

    if (lastIndex < nameStart) {
      nodes.push(body.slice(lastIndex, nameStart));
    }

    if (member) {
      nodes.push(
        React.createElement(
          'span',
          {
            key: 'm-' + key++,
            className:
              'mention inline-flex items-baseline rounded bg-blue-100 px-1 text-blue-700 font-medium',
            'data-member-id': member.id,
          },
          '@' + member.name
        )
      );
    } else {
      nodes.push(body.slice(nameStart, nameEnd));
    }

    lastIndex = nameEnd;
  }

  if (lastIndex < body.length) {
    nodes.push(body.slice(lastIndex));
  }

  return nodes;
}

/**
 * Convenience: just the mentioned member IDs, for POST payloads.
 */
export function extractMentionedIds(body: string, members: MentionMember[]): string[] {
  return parseMentions(body, members).mentioned_ids;
}
