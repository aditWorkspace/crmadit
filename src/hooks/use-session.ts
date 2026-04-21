'use client';

import { useState, useEffect, useRef, createContext, useContext } from 'react';
import { SessionUser } from '@/types';

interface SessionContextValue {
  user: SessionUser | null;
  setUser: (user: SessionUser | null) => void;
  isLoading: boolean;
}

export const SessionContext = createContext<SessionContextValue>({
  user: null,
  setUser: () => {},
  isLoading: true,
});

export function useSession() {
  return useContext(SessionContext);
}

const SESSION_KEY = 'proxi_session';
const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour hard timeout

interface StoredSession {
  user: SessionUser;
  expiresAt: number;
}

export function useSessionState(): SessionContextValue {
  const [user, setUserState] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const clearSession = (redirect: boolean) => {
    clearTimer();
    setUserState(null);
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    // Best-effort server-side cookie clear. Don't block on it.
    try { fetch('/api/auth/signout', { method: 'POST', credentials: 'include' }); } catch { /* ignore */ }
    // Full reload wipes in-memory React state so the next user doesn't briefly
    // see the previous user's cached data.
    if (redirect && typeof window !== 'undefined') {
      window.location.href = '/';
    }
  };

  const scheduleExpiry = (expiresAt: number) => {
    clearTimer();
    const ms = expiresAt - Date.now();
    if (ms <= 0) { clearSession(true); return; }
    timerRef.current = setTimeout(() => clearSession(true), ms);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Server-side cookie is the source of truth. Verify before trusting
      // sessionStorage — stale clients without a cookie must re-PIN.
      try {
        const res = await fetch('/api/session', { credentials: 'include', cache: 'no-store' });
        if (cancelled) return;
        if (!res.ok) {
          try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
          setUserState(null);
          setIsLoading(false);
          return;
        }
        const data = await res.json();
        const verified: SessionUser = { team_member_id: data.member.id, name: data.member.name };
        const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
        setUserState(verified);
        try {
          const payload: StoredSession = { user: verified, expiresAt };
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
        } catch { /* ignore */ }
        scheduleExpiry(expiresAt);
      } catch {
        // Network error: fall back to cached value, but only if not expired.
        try {
          const stored = sessionStorage.getItem(SESSION_KEY);
          if (stored) {
            const parsed = JSON.parse(stored) as Partial<StoredSession>;
            if (parsed.user && typeof parsed.expiresAt === 'number' && parsed.expiresAt > Date.now()) {
              setUserState(parsed.user);
              scheduleExpiry(parsed.expiresAt);
            } else {
              sessionStorage.removeItem(SESSION_KEY);
            }
          }
        } catch { /* ignore */ }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    // Re-check when the tab regains focus (covers laptop sleep, long backgrounding).
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const stored = sessionStorage.getItem(SESSION_KEY);
        if (!stored) return;
        const parsed = JSON.parse(stored) as Partial<StoredSession>;
        if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) {
          clearSession(true);
        }
      } catch { /* ignore */ }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const setUser = (newUser: SessionUser | null) => {
    if (!newUser) {
      clearSession(true);
      return;
    }
    const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
    setUserState(newUser);
    try {
      const payload: StoredSession = { user: newUser, expiresAt };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch { /* ignore storage errors */ }
    scheduleExpiry(expiresAt);
  };

  return { user, setUser, isLoading };
}
