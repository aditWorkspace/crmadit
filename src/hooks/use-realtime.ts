'use client';

import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

export function useLeadRealtime(callback: () => void): void {
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('leads-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'leads' },
        () => {
          callback();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  // callback is intentionally excluded — callers should memoize it
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
