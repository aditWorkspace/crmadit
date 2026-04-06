'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Users,
  Kanban,
  Bell,
  BarChart3,
  Settings,
  LogOut,
  Menu,
  X,
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/leads', label: 'Leads', icon: Users },
  { href: '/pipeline', label: 'Pipeline', icon: Kanban },
  { href: '/follow-ups', label: 'Follow-ups', icon: Bell },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function SidebarContent({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname();
  const { user, setUser } = useSession();

  return (
    <aside className="flex h-full w-56 flex-col border-r border-gray-100 bg-white">
      <div className="flex h-14 items-center px-4 border-b border-gray-100 justify-between">
        <span className="text-lg font-semibold text-gray-900">Proxi CRM</span>
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
              pathname === href
                ? 'bg-gray-900 text-white'
                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </nav>

      {user && (
        <div className="border-t border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-gray-900 flex items-center justify-center text-white text-sm font-medium">
              {user.name[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{user.name}</p>
            </div>
            <button
              onClick={() => setUser(null)}
              className="text-gray-400 hover:text-gray-600"
              title="Switch user"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        className="md:hidden fixed top-4 left-4 z-40 h-9 w-9 rounded-lg bg-white border border-gray-200 shadow-sm flex items-center justify-center text-gray-600 hover:text-gray-900"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Desktop sidebar — always visible */}
      <div className="hidden md:flex h-screen w-56 flex-shrink-0">
        <SidebarContent />
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <div
        className={cn(
          'md:hidden fixed inset-y-0 left-0 z-50 w-56 transition-transform duration-200',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <SidebarContent onClose={() => setMobileOpen(false)} />
      </div>
    </>
  );
}
