'use client';

import { usePathname } from 'next/navigation';
import { SessionContext, useSessionState } from '@/hooks/use-session';
import { ThemeContext, useThemeState } from '@/hooks/use-theme';
import { TopNav } from './top-nav';
import { DotGrid } from './dot-grid';
import { PageTransition } from './page-transition';
import { UserSelectorModal } from './user-selector-modal';
import { ErrorBoundary } from '@/components/error-boundary';
import { CommandPaletteProvider } from '@/components/command-palette';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const sessionState = useSessionState();
  const themeState = useThemeState();

  // Skip shell (nav + modal) for public /book routes
  const isPublicPage = pathname.startsWith('/book');

  if (isPublicPage) {
    return (
      <ThemeContext.Provider value={themeState}>
        <ErrorBoundary>{children}</ErrorBoundary>
      </ThemeContext.Provider>
    );
  }

  return (
    <ThemeContext.Provider value={themeState}>
      <SessionContext.Provider value={sessionState}>
        <UserSelectorModal />
        <CommandPaletteProvider />
        <div className="relative min-h-screen">
          <DotGrid />
          <TopNav />
          <main className="relative z-10 pt-[var(--topnav-height)]">
            <PageTransition>
              <ErrorBoundary>{children}</ErrorBoundary>
            </PageTransition>
          </main>
        </div>
      </SessionContext.Provider>
    </ThemeContext.Provider>
  );
}
