// Tolerant JSON extraction for LLM output. Same algorithm as the private
// helper in first-reply-classifier.ts, lifted into a shared module for the
// cold-email personalization code (extraction + claim-check). The original
// caller keeps its own copy — this is purely additive, no refactor of working
// code.
//
// Scans for the first balanced top-level JSON object and parses it. Tolerates
// leading prose, trailing explanation after the closing brace, and stray
// code-fence-like content. Does NOT tolerate raw unescaped newlines inside
// string values — if the model emits those the string-state tracker bails and
// the caller falls back to its safe default.
export function tolerantJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to the scanner */
  }

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      if (start === -1) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return JSON.parse(raw.slice(start, i + 1));
      }
    }
  }

  throw new Error('no balanced JSON object found');
}
