'use client';

import { useState, useEffect, createContext, useContext } from 'react';
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

export function useSessionState(): SessionContextValue {
  const [user, setUserState] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // sessionStorage: cleared when the browser tab/session closes.
    // Password must be re-entered in a fresh session.
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) setUserState(JSON.parse(stored));
    } catch { /* ignore parse errors */ }
    setIsLoading(false);
  }, []);

  const setUser = (newUser: SessionUser | null) => {
    setUserState(newUser);
    try {
      if (newUser) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(newUser));
      } else {
        sessionStorage.removeItem(SESSION_KEY);
      }
    } catch { /* ignore storage errors */ }
  };

  return { user, setUser, isLoading };
}
