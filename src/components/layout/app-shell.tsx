'use client';

import { SessionContext, useSessionState } from '@/hooks/use-session';
import { Sidebar } from './sidebar';
import { UserSelectorModal } from './user-selector-modal';

export function AppShell({ children }: { children: React.ReactNode }) {
  const sessionState = useSessionState();

  return (
    <SessionContext.Provider value={sessionState}>
      <UserSelectorModal />
      <div className="flex h-screen overflow-hidden bg-gray-50">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </SessionContext.Provider>
  );
}
