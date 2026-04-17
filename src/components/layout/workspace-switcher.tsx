'use client';

import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { ChevronDown, Check } from '@/lib/icons';

export function WorkspaceSwitcher() {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger
        className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-strong)]"
        aria-label="Switch workspace"
      >
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: 'var(--rainbow-gradient)' }}
          aria-hidden
        />
        <span>Proxi CRM</span>
        <ChevronDown className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner side="bottom" align="start" sideOffset={6}>
          <MenuPrimitive.Popup className="card min-w-[200px] p-1 z-50 outline-none">
            <MenuPrimitive.Item
              disabled
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--text-primary)] data-disabled:opacity-100 cursor-default select-none outline-none"
            >
              <span className="inline-flex items-center gap-2">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: 'var(--rainbow-gradient)' }}
                  aria-hidden
                />
                Proxi CRM
              </span>
              <Check className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
            </MenuPrimitive.Item>
            <MenuPrimitive.Separator className="my-1 h-px bg-[var(--border)]" />
            <MenuPrimitive.Item
              disabled
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--text-tertiary)] data-disabled:opacity-60 cursor-default select-none outline-none"
            >
              + Add workspace
            </MenuPrimitive.Item>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
