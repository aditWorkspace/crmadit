'use client';

// Left sidebar navigation. Replaces the previous top-nav.
//
// Layout:
//   [+ New lead]
//
//   Pipeline           ← top-level (Home equivalent, no category)
//   Inbox
//
//   PIPELINE OPS  ▾    ← collapsible category
//     Calendar
//     Follow-ups
//
//   OUTREACH      ▾
//     Outreach
//     Cold Outreach
//
//   CHATS         ▾
//     Insights
//     Actions
//     Advisors
//
//   ─────────────────  ← separator pushed to bottom via flex-1 spacer
//   Analytics          ← demoted, low-emphasis
//
//   [User menu]        ← Settings + Logout live in the popover, not the nav
//
// Persistence: sidebar collapse state and per-category expand state are
// kept in localStorage (per-browser, not per-user — these are UX prefs,
// not auth state).

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  CalendarDays,
  Send,
  Clock,
  BarChart3,
  BookOpen,
  Mail,
  Zap,
  Users,
  Target,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
} from '@/lib/icons';
import { UserMenu } from './user-menu';
import { LeadFormModal } from '@/components/leads/lead-form';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavGroup {
  id: string;        // stable id for localStorage key
  label: string;
  items: NavItem[];
}

const TOP_LEVEL: NavItem[] = [
  { href: '/',      label: 'Pipeline', icon: LayoutDashboard },
  { href: '/inbox', label: 'Inbox',    icon: Mail },
];

const GROUPS: NavGroup[] = [
  {
    id: 'pipeline-ops',
    label: 'Pipeline ops',
    items: [
      { href: '/calendar',   label: 'Calendar',   icon: CalendarDays },
      { href: '/follow-ups', label: 'Follow-ups', icon: Clock },
    ],
  },
  {
    id: 'outreach',
    label: 'Outreach',
    items: [
      { href: '/mass-email', label: 'Outreach',      icon: Send },
      { href: '/email-tool', label: 'Cold Outreach', icon: Target },
    ],
  },
  {
    id: 'chats',
    label: 'Chats',
    items: [
      { href: '/insights', label: 'Insights', icon: BookOpen },
      { href: '/actions',  label: 'Actions',  icon: Zap },
      { href: '/advisors', label: 'Advisors', icon: Users },
    ],
  },
];

const FOOTER_ITEMS: NavItem[] = [
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
];

const COLLAPSED_KEY = 'sidenav:collapsed';
const GROUP_STATE_KEY = 'sidenav:groups';

export function SideNav() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const g of GROUPS) init[g.id] = true;
    return init;
  });
  const [showAddLead, setShowAddLead] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate persisted prefs on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === '1');
    try {
      const raw = window.localStorage.getItem(GROUP_STATE_KEY);
      if (raw) setGroupOpen(prev => ({ ...prev, ...(JSON.parse(raw) as Record<string, boolean>) }));
    } catch { /* keep defaults */ }
    setHydrated(true);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      if (typeof window !== 'undefined') window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };

  const toggleGroup = (id: string) => {
    setGroupOpen(prev => {
      const next = { ...prev, [id]: !prev[id] };
      if (typeof window !== 'undefined') window.localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(next));
      return next;
    });
  };

  // Auto-expand the parent of the active route so users never lose
  // their position to a collapsed group.
  useEffect(() => {
    for (const g of GROUPS) {
      if (g.items.some(it => isActive(pathname, it.href)) && !groupOpen[g.id]) {
        setGroupOpen(prev => ({ ...prev, [g.id]: true }));
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <>
      <nav
        aria-label="Primary"
        className={cn(
          'fixed top-0 left-0 h-screen flex flex-col bg-white border-r border-gray-200 z-30 transition-[width] duration-200',
          collapsed ? 'w-[56px]' : 'w-[240px]',
        )}
      >
        {/* Header — workspace label + collapse toggle */}
        <div className="px-3 pt-3 pb-2 flex items-center justify-between">
          {!collapsed && (
            <span className="font-display text-sm font-semibold text-gray-900 px-1">Proxi CRM</span>
          )}
          <button
            onClick={toggleCollapsed}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>

        {/* + New lead */}
        <div className="px-2 pb-2">
          <button
            onClick={() => setShowAddLead(true)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors',
              collapsed && 'justify-center px-0',
            )}
            title="Add a new lead"
          >
            <Plus className="h-4 w-4 flex-shrink-0" />
            {!collapsed && <span>New lead</span>}
          </button>
        </div>

        {/* Items */}
        <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
          {TOP_LEVEL.map(item => (
            <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} />
          ))}

          {GROUPS.map(group => {
            const isOpen = hydrated ? groupOpen[group.id] !== false : true;
            const groupHasActive = group.items.some(it => isActive(pathname, it.href));
            return (
              <div key={group.id} className="pt-3">
                {!collapsed && (
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className="w-full flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <span>{group.label}</span>
                    <ChevronDown
                      className={cn(
                        'h-3 w-3 transition-transform duration-200',
                        isOpen ? 'rotate-0' : '-rotate-90',
                      )}
                    />
                  </button>
                )}
                {(isOpen || groupHasActive || collapsed) && (
                  <div className="mt-0.5 space-y-0.5">
                    {group.items.map(item => (
                      <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer items (low-emphasis) + user menu */}
        <div className="px-2 py-2 border-t border-gray-100 space-y-0.5">
          {FOOTER_ITEMS.map(item => (
            <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} dim />
          ))}
        </div>
        <div className={cn('p-2 border-t border-gray-100', collapsed && 'flex justify-center')}>
          <UserMenu compact={collapsed} />
        </div>
      </nav>

      {/* Spacer in the document so main content doesn't sit under the
          fixed sidebar. Width matches sidebar exactly. */}
      <div
        className={cn('flex-shrink-0 transition-[width] duration-200', collapsed ? 'w-[56px]' : 'w-[240px]')}
        aria-hidden
      />

      <LeadFormModal
        open={showAddLead}
        onClose={() => setShowAddLead(false)}
        onSuccess={() => setShowAddLead(false)}
      />
    </>
  );
}

function NavLink({
  item,
  pathname,
  collapsed,
  dim,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  dim?: boolean;
}) {
  const Icon = item.icon;
  const active = isActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={cn(
        'flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm transition-colors',
        active
          ? 'bg-gray-100 text-gray-900 font-medium'
          : dim
            ? 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
            : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname.startsWith(href);
}
