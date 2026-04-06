'use client';

import { usePathname } from 'next/navigation';
import { SessionContext, useSessionState } from '@/hooks/use-session';
import { ThemeContext, useThemeState } from '@/hooks/use-theme';
import { Sidebar } from './sidebar';
import { UserSelectorModal } from './user-selector-modal';
import { ErrorBoundary } from '@/components/error-boundary';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const sessionState = useSessionState();
  const themeState = useThemeState();

  // Skip sidebar and modal for /book routes
  const isPublicPage = pathname.startsWith('/book');

  if (isPublicPage) {
    return (
      <ThemeContext.Provider value={themeState}>
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </ThemeContext.Provider>
    );
  }

  return (
    <ThemeContext.Provider value={themeState}>
      <SessionContext.Provider value={sessionState}>
        <UserSelectorModal />
        <div className="flex h-screen overflow-hidden bg-gray-50">
          <Sidebar />
          <main className="flex-1 overflow-auto">
            <ErrorBoundary>
              {children}
            </ErrorBoundary>
          </main>
        </div>
      </SessionContext.Provider>
    </ThemeContext.Provider>
  );
}
