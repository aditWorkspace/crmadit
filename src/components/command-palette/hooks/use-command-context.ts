'use client';

import { usePathname, useSearchParams } from 'next/navigation';

export type CommandContext = {
  currentLeadId: string | null;
  currentThreadId: string | null;
};

/**
 * Derives the currently-focused entity from the URL so actions in the
 * command palette can target "this lead" / "this thread".
 */
export function useCommandContext(): CommandContext {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  let currentLeadId: string | null = null;
  if (pathname) {
    const match = pathname.match(/^\/leads\/([^/?#]+)/);
    if (match) currentLeadId = match[1];
  }

  let currentThreadId: string | null = null;
  if (pathname && pathname.startsWith('/inbox')) {
    const threadId = searchParams?.get('thread');
    if (threadId) currentThreadId = threadId;
  }

  return { currentLeadId, currentThreadId };
}
