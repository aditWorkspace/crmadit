'use client';

import { useEffect } from 'react';
import { getHotkeyState } from './use-global-hotkey-state';

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export interface InboxKeyboardHandlers {
  onMoveSelection?: (direction: 1 | -1) => void;
  onReply?: () => void;
  onArchive?: () => void;
  onSnooze?: () => void;
  onDelete?: () => void;
  onToggleUnread?: () => void;
}

/**
 * Binds j/k/r/e/s/#/u to inbox actions.
 * Respects the global command palette open state (Lane E) and any focused
 * input/textarea — all bindings abort when either is true.
 */
export function useInboxKeyboard(handlers: InboxKeyboardHandlers): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Fallback for environments where Lane E hasn't attached yet.
      const paletteOpen =
        getHotkeyState?.().paletteOpen ??
        (globalThis as { __hotkeyState?: { paletteOpen?: boolean } }).__hotkeyState?.paletteOpen ??
        false;
      if (paletteOpen) return;
      if (isInputFocused()) return;

      switch (e.key) {
        case 'j':
          e.preventDefault();
          handlers.onMoveSelection?.(1);
          break;
        case 'k':
          e.preventDefault();
          handlers.onMoveSelection?.(-1);
          break;
        case 'r':
          e.preventDefault();
          handlers.onReply?.();
          break;
        case 'e':
          e.preventDefault();
          handlers.onArchive?.();
          break;
        case 's':
          e.preventDefault();
          handlers.onSnooze?.();
          break;
        case '#':
          e.preventDefault();
          handlers.onDelete?.();
          break;
        case 'u':
          e.preventDefault();
          handlers.onToggleUnread?.();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handlers]);
}
