'use client';

import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Subscribe to Supabase Realtime changes on the two tables that drive the inbox:
 *   - `interactions` (new emails → new rows, possibly updated snippets)
 *   - `thread_state` (snooze/archive toggles)
 * Calls the provided callback (debounced to ~500ms) on any change so callers
 * can refresh their thread list + counts.
 */
export function useInboxRealtime(callback: () => void): void {
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  });

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cbRef.current(), 500);
    };

    const channel = supabase
      .channel('inbox-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'interactions' },
        trigger
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'thread_state' },
        trigger
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, []);
}
