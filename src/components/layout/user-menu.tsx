'use client';

import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { useRouter } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { Settings, LogOut, User } from '@/lib/icons';

export function UserMenu() {
  const { user, setUser } = useSession();
  const router = useRouter();

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : '?';

  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger
        aria-label="User menu"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-primary)] text-xs font-semibold text-[var(--text-inverse)] outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-[var(--border-strong)]"
      >
        {initials}
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner side="bottom" align="end" sideOffset={8}>
          <MenuPrimitive.Popup className="card min-w-[200px] p-1 z-50 outline-none">
            {user && (
              <>
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{user.name}</p>
                </div>
                <MenuPrimitive.Separator className="my-1 h-px bg-[var(--border)]" />
              </>
            )}
            <MenuPrimitive.Item
              onClick={() => setUser(null)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-muted)] cursor-default select-none outline-none"
            >
              <User className="h-4 w-4 text-[var(--text-secondary)]" />
              Switch user
            </MenuPrimitive.Item>
            <MenuPrimitive.Item
              onClick={() => router.push('/settings')}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-muted)] cursor-default select-none outline-none"
            >
              <Settings className="h-4 w-4 text-[var(--text-secondary)]" />
              Settings
            </MenuPrimitive.Item>
            <MenuPrimitive.Separator className="my-1 h-px bg-[var(--border)]" />
            <MenuPrimitive.Item
              onClick={() => setUser(null)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--danger)] hover:bg-[var(--surface-muted)] cursor-default select-none outline-none"
            >
              <LogOut className="h-4 w-4" />
              Log out
            </MenuPrimitive.Item>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
