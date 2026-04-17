'use client';

import { useEffect, useState } from 'react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
} from '@/components/ui/command';
import { setPaletteOpen } from '@/hooks/use-global-hotkey-state';
import { ActionsGroup } from './groups/actions';
import { NavigationGroup } from './groups/navigation';
import { LeadsGroup } from './groups/leads';
import { ThreadsGroup } from './groups/threads';
import { useCommandContext } from './hooks/use-command-context';

export function Palette() {
  const [query, setQuery] = useState('');
  const context = useCommandContext();

  useEffect(() => {
    // Focus lock / body scroll freeze while palette is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const close = () => setPaletteOpen(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close command palette"
        className="fixed inset-0 bg-black/30 backdrop-blur-sm"
        onClick={close}
      />

      {/* Panel */}
      <div className="card relative z-10 w-full max-w-xl overflow-hidden rounded-xl bg-background shadow-lg">
        <Command
          shouldFilter
          label="Command palette"
          className="bg-transparent"
        >
          <CommandInput
            autoFocus
            placeholder="Search leads, threads, or commands..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[60vh]">
            <CommandEmpty>No results.</CommandEmpty>
            <ActionsGroup context={context} onSelect={close} />
            <NavigationGroup onSelect={close} />
            <LeadsGroup query={query} onSelect={close} />
            <ThreadsGroup query={query} onSelect={close} />
          </CommandList>
        </Command>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="kbd">&#9166;</span>
            <span>to select</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="kbd">&#8593;</span>
            <span className="kbd">&#8595;</span>
            <span>to navigate</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="kbd">esc</span>
            <span>to close</span>
          </div>
        </div>
      </div>
    </div>
  );
}
