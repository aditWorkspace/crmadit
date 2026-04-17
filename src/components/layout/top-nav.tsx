'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  CalendarDays,
  Send,
  Clock,
  BarChart3,
  BookOpen,
  Settings,
  Mail,
} from '@/lib/icons';
import { WorkspaceSwitcher } from './workspace-switcher';
import { UserMenu } from './user-menu';
import { NotificationBell } from '@/components/notifications/notification-bell';

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Pipeline', icon: LayoutDashboard },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/mass-email', label: 'Outreach', icon: Send },
  { href: '/follow-ups', label: 'Follow-ups', icon: Clock },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/insights', label: 'Insights', icon: BookOpen },
  { href: '/inbox', label: 'Inbox', icon: Mail },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function TopNav() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  return (
    <header className="topnav">
      {/* SVG gradient defs for any child icon that wants fill="url(#nav-rainbow-grad)" */}
      <svg width="0" height="0" aria-hidden className="absolute">
        <defs>
          <linearGradient id="nav-rainbow-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#ff3b30" />
            <stop offset="16%" stopColor="#ff9500" />
            <stop offset="33%" stopColor="#ffcc00" />
            <stop offset="50%" stopColor="#34c759" />
            <stop offset="66%" stopColor="#007aff" />
            <stop offset="83%" stopColor="#5856d6" />
            <stop offset="100%" stopColor="#af52de" />
          </linearGradient>
        </defs>
      </svg>

      <div className="mx-auto flex h-full w-full items-center justify-between gap-4 px-4">
        {/* Left: workspace switcher + brand wordmark */}
        <div className="flex items-center gap-3">
          <WorkspaceSwitcher />
          <span
            className="hidden h-5 w-px bg-[var(--border)] md:block"
            aria-hidden
          />
          <span
            className="rainbow-flow hidden text-sm font-semibold tracking-tight md:inline"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Proxi CRM
          </span>
        </div>

        {/* Center: primary nav */}
        <nav className="flex items-center gap-1" aria-label="Primary">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                className="nav-item"
                data-active={active}
                aria-current={active ? 'page' : undefined}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden lg:inline">{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Right: notification slot + user menu */}
        <div className="flex items-center gap-2">
          <div id="topnav-right-slot" className="flex items-center"><NotificationBell /></div>
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
