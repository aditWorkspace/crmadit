'use client';

import { useSyncExternalStore } from 'react';

type State = { paletteOpen: boolean };

let state: State = { paletteOpen: false };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setPaletteOpen(open: boolean) {
  if (state.paletteOpen === open) return;
  state = { ...state, paletteOpen: open };
  emit();
}

export function getHotkeyState(): State {
  return state;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getServerSnapshot(): State {
  return state;
}

export function useHotkeyState(): State {
  return useSyncExternalStore(subscribe, () => state, getServerSnapshot);
}
