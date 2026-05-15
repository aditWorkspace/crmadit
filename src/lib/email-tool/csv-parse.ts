// Shared streaming CSV parser. RFC 4180 compliant — honors quoted
// multi-line cells. Extracted from csv-filter/route.ts so the new
// enrich-upload route can reuse it without copy-pasting.
//
// History: previous per-line parser tore rows whenever a quoted cell
// contained a literal newline, causing the 2026-05-15 off-by-N
// alignment incident. This single-pass scanner fixes it structurally.

export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  let cellStarted = false; // tracks whether we've consumed any non-quote chars in current cell
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else {
      if (c === ',') {
        row.push(cur);
        cur = '';
        cellStarted = false;
      } else if (c === '\r') {
        // ignore — row ends on \n; \r\n becomes single \n boundary
      } else if (c === '\n') {
        row.push(cur);
        cur = '';
        cellStarted = false;
        if (row.some(f => f !== '')) rows.push(row);
        row = [];
      } else if (c === '"' && !cellStarted) {
        inQuotes = true;
        cellStarted = true;
      } else {
        cur += c;
        cellStarted = true;
      }
    }
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    if (row.some(f => f !== '')) rows.push(row);
  }
  return rows.map(r => r.map(f => f.trim()));
}

/** Tolerant header → column-index mapping for enrich-upload. */
export interface EnrichColMap {
  first_name: number | null;
  full_name: number | null;
  company: number | null;
  email: number | null;
}

function norm(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function inferEnrichColMap(header: string[]): EnrichColMap {
  const normed = header.map(norm);
  const findIdx = (...patterns: RegExp[]) => {
    for (let i = 0; i < normed.length; i++) {
      if (patterns.some(p => p.test(normed[i]))) return i;
    }
    return null;
  };
  const firstIdx = findIdx(/^firstname$/, /^first$/, /^fname$/, /^givenname$/);
  // "name" or "contact" or "fullname" — but NOT "first name" (caught above).
  const fullIdx = findIdx(/^name$/, /^contact$/, /^fullname$/, /^contactname$/, /^contactperson$/);
  const companyIdx = findIdx(/^company$/, /^companyname$/, /^organization$/, /^org$/, /^website$/, /^url$/, /^domain$/, /^companywebsite$/);
  const emailIdx = findIdx(/^email$/, /^emailaddress$/, /^workemail$/);
  return {
    first_name: firstIdx,
    full_name: fullIdx,
    company: companyIdx,
    email: emailIdx,
  };
}
