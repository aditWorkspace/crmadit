'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { Settings, LogOut, User } from '@/lib/icons';

export function UserMenu() {
  const { user, setUser } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : '?';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleSignOut = () => {
    setOpen(false);
    // Atomic server-side cookie clear + redirect. No fetch race.
    if (typeof window !== 'undefined') window.location.href = '/api/auth/signout';
  };

  const handleSwitchUser = () => {
    setOpen(false);
    setUser(null);
  };

  const handleSettings = () => {
    setOpen(false);
    router.push('/settings');
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="User menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-primary)] text-xs font-semibold text-[var(--text-inverse)] outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-[var(--border-strong)]"
      >
        {initials}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-[60] min-w-[200px] rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg outline-none"
        >
          {user && (
            <>
              <div className="px-2 py-1.5">
                <p className="text-sm font-medium text-[var(--text-primary)]">{user.name}</p>
              </div>
              <div className="my-1 h-px bg-[var(--border)]" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={handleSwitchUser}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--surface-muted)] outline-none"
          >
            <User className="h-4 w-4 text-[var(--text-secondary)]" />
            Switch user
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleSettings}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--surface-muted)] outline-none"
          >
            <Settings className="h-4 w-4 text-[var(--text-secondary)]" />
            Settings
          </button>
          <div className="my-1 h-px bg-[var(--border)]" />
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--danger)] hover:bg-[var(--surface-muted)] outline-none"
          >
            <LogOut className="h-4 w-4" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
