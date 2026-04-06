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

export function useSessionState(): SessionContextValue {
  const [user, setUserState] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem('proxi_session');
    if (stored) {
      try {
        setUserState(JSON.parse(stored));
      } catch {}
    }
    setIsLoading(false);
  }, []);

  const setUser = (newUser: SessionUser | null) => {
    setUserState(newUser);
    if (newUser) {
      localStorage.setItem('proxi_session', JSON.stringify(newUser));
    } else {
      localStorage.removeItem('proxi_session');
    }
  };

  return { user, setUser, isLoading };
}
