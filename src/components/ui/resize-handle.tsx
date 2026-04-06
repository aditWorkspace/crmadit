'use client';

import { useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';

interface ResizeHandleProps {
  /** localStorage key to persist the resized width */
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** Called with the new width on every drag move */
  onResize: (width: number) => void;
  className?: string;
}

export function ResizeHandle({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  onResize,
  className,
}: ResizeHandleProps) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(defaultWidth);

  // Restore persisted width on mount
  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const w = parseInt(stored, 10);
      if (!isNaN(w) && w >= minWidth && w <= maxWidth) onResize(w);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = parseInt(localStorage.getItem(storageKey) ?? String(defaultWidth), 10);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [storageKey, defaultWidth]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta));
      onResize(newWidth);
      localStorage.setItem(storageKey, String(Math.round(newWidth)));
    };
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [minWidth, maxWidth, onResize]);

  return (
    <div
      onMouseDown={onMouseDown}
      className={cn(
        'w-1 flex-shrink-0 cursor-col-resize bg-gray-100 hover:bg-blue-400 active:bg-blue-500 transition-colors',
        className
      )}
    />
  );
}
