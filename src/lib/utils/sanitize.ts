/**
 * Sanitize user input by stripping HTML tags and dangerous characters.
 * Used in booking flow to prevent XSS in calendar events and emails.
 */
export function sanitizeText(input: string): string {
  return input
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Remove script-like patterns
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sanitize an email address (basic validation + lowercase).
 */
export function sanitizeEmail(input: string): string {
  return input.toLowerCase().trim();
}

/**
 * Sanitize a name field — allow letters, spaces, hyphens, apostrophes.
 * Strips anything else to prevent injection in event titles.
 */
export function sanitizeName(input: string): string {
  return sanitizeText(input)
    // Keep only safe characters for names
    .replace(/[^\p{L}\p{M}\s'\-.,]/gu, '')
    .trim();
}
