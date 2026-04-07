'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { HelpPanel } from './help-panel';
import { cn } from '@/lib/utils';
import { TeamMember } from '@/types';
import {
  LayoutDashboard, BarChart3, Settings,
  LogOut, Menu, X, Moon, Sun, CalendarDays,
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', label: 'Pipeline', icon: LayoutDashboard },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function SidebarContent({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname();
  const { user, setUser } = useSession();
  const { theme, toggle } = useTheme();
  const [members, setMembers] = useState<TeamMember[]>([]);

  useEffect(() => {
    fetch('/api/team/members')
      .then(r => r.json())
      .then(d => setMembers(d.members || []));
  }, []);

  // "/" matches pipeline; also match "/?id=..."
  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  return (
    <aside className="flex h-full w-52 flex-col border-r border-gray-100 bg-white">
      <div className="flex h-14 items-center px-4 border-b border-gray-100 justify-between">
        <span className="text-base font-semibold text-gray-900 tracking-tight">Proxi CRM</span>
        {onClose && (
          <button onClick={onClose} className="md:hidden text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={onClose}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
              isActive(href)
                ? 'bg-gray-900 text-white'
                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </nav>

      <div className="border-t border-gray-100 p-3 space-y-2">
        <div className="flex items-center justify-between px-2">
          <HelpPanel />
          <button
            onClick={toggle}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-md hover:bg-gray-100 transition-colors"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
        {user && (
          <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <div className="h-7 w-7 rounded-full bg-gray-900 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
              {user.name[0]?.toUpperCase()}
            </div>
            <p className="text-sm font-medium text-gray-900 truncate flex-1">{user.name}</p>
            <button onClick={() => setUser(null)} className="text-gray-400 hover:text-gray-600" title="Log out">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileOpen]);

  return (
    <>
      <button
        className="md:hidden fixed top-4 left-4 z-40 h-9 w-9 rounded-lg bg-white border border-gray-200 shadow-sm flex items-center justify-center text-gray-600 hover:text-gray-900"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      <div className="hidden md:flex h-screen w-52 flex-shrink-0">
        <SidebarContent />
      </div>

      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={() => setMobileOpen(false)} />
      )}

      <div className={cn(
        'md:hidden fixed inset-y-0 left-0 z-50 w-52 transition-transform duration-200',
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      )}>
        <SidebarContent onClose={() => setMobileOpen(false)} />
      </div>
    </>
  );
}
