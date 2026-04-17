'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInboxPresence } from '@/hooks/use-inbox-presence';
import { useThreadPresence } from '@/hooks/use-thread-presence';
import { PresenceAvatars } from './presence-avatars';

/**
 * Singleton mounted once on /inbox. Owns:
 *  - The global `inbox:presence` channel (so other members see US on a thread)
 *  - The per-thread `thread:<id>` channel (so we see THEM on our thread)
 *  - Portaling stacked avatars into ThreadReader's `[data-slot="thread-header-right"]`.
 *
 * The currently-viewed threadId is discovered from the DOM (the snooze-trigger
 * button in ThreadReader always carries `data-thread-id`) so we don't need
 * coupling to InboxPane's state.
 */
export function PresenceStrip() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [slot, setSlot] = useState<Element | null>(null);

  useInboxPresence(threadId);
  const { viewers } = useThreadPresence(threadId);

  // Observe DOM for the active thread. ThreadReader remounts on each selection,
  // so a MutationObserver on the body catches every change cheaply.
  useEffect(() => {
    const read = () => {
      const btn = document.querySelector<HTMLElement>(
        '[data-action="snooze-trigger"][data-thread-id]'
      );
      const id = btn?.getAttribute('data-thread-id') ?? null;
      setThreadId(prev => (prev === id ? prev : id));
      const s = document.querySelector('[data-slot="thread-header-right"]');
      setSlot(prev => (prev === s ? prev : s));
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  if (!threadId || !slot) return null;
  if (viewers.length === 0) return null;

  return createPortal(<PresenceAvatars viewers={viewers} />, slot);
}
