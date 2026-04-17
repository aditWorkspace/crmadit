/**
 * Owner color palette shared by lead-list, thread-list, and thread-reader.
 * Keyed by team-member name (not id) because the codebase already
 * references names in UI; a second map could be added if we move
 * to id-based lookups later.
 */

export type OwnerColor = { bg: string; text: string; dot: string };

const DEFAULT: OwnerColor = {
  bg: 'bg-gray-100',
  text: 'text-gray-700',
  dot: 'bg-gray-400',
};

export const OWNER_COLORS: Record<string, OwnerColor> = {
  Adit:   { bg: 'bg-blue-100',    text: 'text-blue-700',    dot: 'bg-blue-500' },
  Srijay: { bg: 'bg-purple-100',  text: 'text-purple-700',  dot: 'bg-purple-500' },
  Asim:   { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' },
};

export function ownerColor(name: string | null | undefined): OwnerColor {
  if (!name) return DEFAULT;
  return OWNER_COLORS[name] ?? DEFAULT;
}
