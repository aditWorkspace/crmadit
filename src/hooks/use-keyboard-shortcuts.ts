'use client';

import { useEffect } from 'react';

interface KeyboardShortcutsOptions {
  onNewLead?: () => void;
  onSearch?: () => void;
  onEscape?: () => void;
}

function isInputFocused(): boolean {
  const tag = document.activeElement?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

export function useKeyboardShortcuts(options: KeyboardShortcutsOptions): void {
  const { onNewLead, onSearch, onEscape } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Escape always fires regardless of focus
      if (e.key === 'Escape') {
        onEscape?.();
        return;
      }

      // Other shortcuts only fire when no input is focused
      if (isInputFocused()) return;

      if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onNewLead?.();
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        onSearch?.();
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onNewLead, onSearch, onEscape]);
}
