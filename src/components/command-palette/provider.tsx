'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getHotkeyState,
  setPaletteOpen,
  useHotkeyState,
} from '@/hooks/use-global-hotkey-state';
import { Palette } from './palette';

/**
 * Mounts a global ⌘K / Ctrl+K listener and renders the command palette
 * into a portal on document.body when open. Place once near the root of
 * the authenticated shell.
 */
export function CommandPaletteProvider() {
  const { paletteOpen } = useHotkeyState();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Toggle palette with ⌘K / Ctrl+K.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        e.stopPropagation();
        setPaletteOpen(!getHotkeyState().paletteOpen);
        return;
      }
      // Close on Escape when open.
      if (e.key === 'Escape' && getHotkeyState().paletteOpen) {
        e.preventDefault();
        setPaletteOpen(false);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!mounted || !paletteOpen) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(<Palette />, document.body);
}
