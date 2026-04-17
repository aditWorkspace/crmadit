'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cn } from '@/lib/utils';
import { Bell } from '@/lib/icons';
import { useSession } from '@/hooks/use-session';
import { createClient } from '@/lib/supabase/client';
import {
  NotificationList,
  type MentionNotification,
} from './notification-list';

const POLL_MS = 60_000;

export function NotificationBell() {
  const { user } = useSession();
  const [notifications, setNotifications] = useState<MentionNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/notifications?unread_only=false', {
        headers: { 'x-team-member-id': user.team_member_id },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      if (Array.isArray(data?.notifications)) setNotifications(data.notifications);
      if (typeof data?.unread_count === 'number') setUnreadCount(data.unread_count);
    } catch {
      /* ignore */
    }
  }, [user]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Initial load + polling
  useEffect(() => {
    if (!user) return;
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [user, load]);

  // Realtime on mention_notifications for this recipient
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`mention-notifications:${user.team_member_id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'mention_notifications',
          filter: `recipient_id=eq.${user.team_member_id}`,
        },
        () => load()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, load]);

  // Refresh when popover opens so counts are current
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  if (!user) return null;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        render={(props) => (
          <button
            type="button"
            aria-label={
              unreadCount > 0
                ? `Notifications (${unreadCount} unread)`
                : 'Notifications'
            }
            className={cn(
              'relative flex h-8 w-8 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-[color:var(--surface-muted)] hover:text-gray-900',
              open && 'bg-[color:var(--surface-muted)] text-gray-900'
            )}
            {...props}
          >
            <Bell className="h-4 w-4" />
            {unreadCount > 0 && (
              <span
                className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white"
                aria-hidden
              />
            )}
          </button>
        )}
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner align="end" side="bottom" sideOffset={8} className="isolate z-50">
          <PopoverPrimitive.Popup
            className={cn(
              'z-50 w-80 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100',
              'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95'
            )}
          >
            <NotificationList
              notifications={notifications}
              onChange={load}
              onClose={() => setOpen(false)}
            />
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
