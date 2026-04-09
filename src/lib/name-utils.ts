/**
 * Smart name normalization utilities.
 *
 * Handles:
 *  - Title-casing ("john smith" → "John Smith")
 *  - Irish/Scottish prefixes ("o'kelly" → "O'Kelly", "mckinsey" → "McKinsey")
 *  - Hyphenated names ("hill-gorman" → "Hill-Gorman")
 *  - Email local-part extraction ("lduarte" → "Lduarte", or better if we can split)
 *  - All-caps/all-lowercase normalization
 *  - Preserves intentional casing on known patterns (AI, MD, PhD, Jr, Sr, III, etc.)
 */

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'md', 'phd', 'dds', 'esq']);
const PREFIXES_LOWER = new Set(['de', 'van', 'von', 'del', 'di', 'la', 'le', 'da', 'el', 'al']);
// Common acronyms that should stay uppercase (used in company names)
const ACRONYMS = new Set(['ai', 'ml', 'xr', 'vr', 'ar', 'hr', 'io', 'os', 'it', 'pm', 'ui', 'ux', 'api', 'saas', 'llm', 'crm', 'erp', 'b2b', 'b2c']);

/**
 * Title-case a single word, handling prefixes like Mc/Mac/O'.
 */
function titleCaseWord(word: string, isCompanyName = false): string {
  const lower = word.toLowerCase();

  // Common acronyms stay uppercase (only in company names to avoid "Ali" → "ALI")
  if (isCompanyName && ACRONYMS.has(lower)) return lower.toUpperCase();

  // Check suffixes that should be uppercase
  if (SUFFIXES.has(lower)) {
    if (['ii', 'iii', 'iv'].includes(lower)) return lower.toUpperCase();
    if (lower === 'md') return 'MD';
    if (lower === 'phd') return 'PhD';
    if (lower === 'dds') return 'DDS';
    if (lower === 'esq') return 'Esq';
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  // Mc prefix: "mckenzie" → "McKenzie"
  if (lower.startsWith('mc') && lower.length > 2) {
    return 'Mc' + lower.charAt(2).toUpperCase() + lower.slice(3);
  }

  // Mac prefix (only if >5 chars to avoid "Mac" as a name)
  if (lower.startsWith('mac') && lower.length > 4 && !['mace', 'mach', 'mack'].includes(lower.slice(0, 4))) {
    return 'Mac' + lower.charAt(3).toUpperCase() + lower.slice(4);
  }

  // O' prefix: "o'kelly" → "O'Kelly"
  if (lower.startsWith("o'") && lower.length > 2) {
    return "O'" + lower.charAt(2).toUpperCase() + lower.slice(3);
  }

  // Standard title case
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Normalize a contact name to proper title case.
 */
export function normalizeName(name: string, isCompanyName = false): string {
  if (!name || !name.trim()) return name;

  // If name is all one word and looks like an email local-part, try to split
  const trimmed = name.trim();

  // Handle names that are clearly email local parts (contains dots or underscores)
  if (trimmed.includes('.') && !trimmed.includes(' ')) {
    // "john.smith" → "John Smith"
    return trimmed
      .split('.')
      .map(part => titleCaseWord(part, isCompanyName))
      .join(' ');
  }
  if (trimmed.includes('_') && !trimmed.includes(' ')) {
    // "john_smith" → "John Smith"
    return trimmed
      .split('_')
      .map(part => titleCaseWord(part, isCompanyName))
      .join(' ');
  }

  // Handle hyphenated parts within names
  const parts = trimmed.split(/\s+/);
  return parts.map((part, idx) => {
    // Handle hyphens within a part: "hill-gorman" → "Hill-Gorman"
    if (part.includes('-')) {
      return part.split('-').map(p => titleCaseWord(p, isCompanyName)).join('-');
    }

    // Lowercase prepositions in middle of name (de, van, etc.)
    if (idx > 0 && idx < parts.length - 1 && PREFIXES_LOWER.has(part.toLowerCase())) {
      return part.toLowerCase();
    }

    return titleCaseWord(part, isCompanyName);
  }).join(' ');
}

/**
 * Extract a clean name from an email address.
 * "lduarte@amoofy.com" → "Lduarte"
 * "john.smith@example.com" → "John Smith"
 * "aditmittal@berkeley.edu" → "Aditmittal" (can't split reliably)
 */
export function nameFromEmailAddress(email: string): string {
  const local = email.split('@')[0];
  if (!local) return email;

  // If has dots or underscores, split and title-case
  if (local.includes('.') || local.includes('_') || local.includes('-')) {
    return local
      .replace(/[._-]+/g, ' ')
      .replace(/\d+/g, '')
      .trim()
      .split(' ')
      .filter(Boolean)
      .map(w => titleCaseWord(w))
      .join(' ') || local;
  }

  // Single word — just title case
  return titleCaseWord(local.replace(/\d+/g, ''));
}

/**
 * Check if a name looks like an email local-part (not a real name).
 */
export function looksLikeEmailLocalPart(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  // Single lowercase word with no spaces — suspicious
  if (!trimmed.includes(' ') && trimmed === trimmed.toLowerCase() && trimmed.length > 2) {
    return true;
  }
  // Contains dots/underscores typical of email
  if (/^[a-z._-]+$/i.test(trimmed) && (trimmed.includes('.') || trimmed.includes('_'))) {
    return true;
  }
  return false;
}
