'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { cn } from '@/lib/utils';

export interface MentionInputMember {
  id: string;
  name: string;
  email?: string;
}

interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  members: MentionInputMember[];
  placeholder?: string;
  onSubmit?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
}

interface PopoverState {
  open: boolean;
  /** Character offset in `value` where the `@` is located */
  triggerIndex: number;
  /** Current search query after the `@` */
  query: string;
  /** Index in the filtered members list that is currently highlighted */
  highlight: number;
}

const INITIAL_POPOVER: PopoverState = {
  open: false,
  triggerIndex: -1,
  query: '',
  highlight: 0,
};

/**
 * Find an open `@<query>` at or before the caret position. Returns the
 * trigger `@` index and the current query, or null if the caret is not
 * inside a mention context.
 */
function findActiveMention(
  text: string,
  caret: number
): { triggerIndex: number; query: string } | null {
  // Walk backwards from caret looking for '@' until we hit whitespace or the
  // start of the string. If we hit '@' first, that's our trigger.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '@') {
      // Must be at start-of-string or preceded by whitespace / bracket / newline
      const prev = i === 0 ? '' : text[i - 1];
      if (i !== 0 && !/[\s(\[{>]/.test(prev)) return null;
      const query = text.slice(i + 1, caret);
      // Only word chars allowed in query — otherwise the mention is closed
      if (!/^[A-Za-z0-9_-]*$/.test(query)) return null;
      return { triggerIndex: i, query };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

export function MentionInput({
  value,
  onChange,
  members,
  placeholder,
  onSubmit,
  disabled,
  className,
  autoFocus,
}: MentionInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [popover, setPopover] = useState<PopoverState>(INITIAL_POPOVER);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const filteredMembers = useMemo(() => {
    if (!popover.open) return [] as MentionInputMember[];
    const q = popover.query.toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.name.toLowerCase().startsWith(q));
  }, [members, popover]);

  // Reset highlight if it falls out of range after filter changes
  useEffect(() => {
    if (popover.open && popover.highlight >= filteredMembers.length) {
      setPopover((p) => ({ ...p, highlight: 0 }));
    }
  }, [filteredMembers.length, popover.open, popover.highlight]);

  const updateFromCaret = useCallback(
    (text: string, caret: number) => {
      const active = findActiveMention(text, caret);
      if (active) {
        setPopover({
          open: true,
          triggerIndex: active.triggerIndex,
          query: active.query,
          highlight: 0,
        });
      } else {
        setPopover(INITIAL_POPOVER);
      }
    },
    []
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    onChange(text);
    const caret = e.target.selectionStart ?? text.length;
    updateFromCaret(text, caret);
  };

  const handleSelectionChange = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? 0;
    updateFromCaret(ta.value, caret);
  };

  const insertMention = useCallback(
    (member: MentionInputMember) => {
      if (popover.triggerIndex < 0) return;
      const before = value.slice(0, popover.triggerIndex);
      const afterCaret = value.slice(
        popover.triggerIndex + 1 + popover.query.length
      );
      const inserted = '@' + member.name + ' ';
      const next = before + inserted + afterCaret;
      onChange(next);
      setPopover(INITIAL_POPOVER);
      // Restore focus and move caret to end of inserted mention
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          const pos = before.length + inserted.length;
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
      });
    },
    [onChange, popover.query.length, popover.triggerIndex, value]
  );

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (popover.open && filteredMembers.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPopover((p) => ({
          ...p,
          highlight: (p.highlight + 1) % filteredMembers.length,
        }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPopover((p) => ({
          ...p,
          highlight:
            (p.highlight - 1 + filteredMembers.length) % filteredMembers.length,
        }));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const chosen = filteredMembers[popover.highlight];
        if (chosen) insertMention(chosen);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const chosen = filteredMembers[popover.highlight];
        if (chosen) insertMention(chosen);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPopover(INITIAL_POPOVER);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !popover.open) {
      e.preventDefault();
      if (!disabled && value.trim()) {
        onSubmit?.(value);
      }
    }
  };

  return (
    <div className={cn('relative', className)}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={handleSelectionChange}
        onClick={handleSelectionChange}
        onFocus={handleSelectionChange}
        placeholder={placeholder}
        disabled={disabled}
        rows={2}
        className="w-full resize-none rounded-md border border-[color:var(--border-subtle)] bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[color:var(--rainbow-5)] focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
      />

      {popover.open && filteredMembers.length > 0 && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-56 overflow-hidden rounded-md border border-[color:var(--border-subtle)] bg-white shadow-md">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-gray-400">
            Mention
          </div>
          <ul className="max-h-48 overflow-y-auto">
            {filteredMembers.map((m, idx) => (
              <li
                key={m.id}
                onMouseDown={(e) => {
                  // mousedown (not click) so the textarea doesn't lose focus first
                  e.preventDefault();
                  insertMention(m);
                }}
                onMouseEnter={() =>
                  setPopover((p) => ({ ...p, highlight: idx }))
                }
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm',
                  idx === popover.highlight
                    ? 'bg-[color:var(--surface-muted)]'
                    : 'hover:bg-[color:var(--surface-muted)]'
                )}
              >
                <span className="font-medium text-gray-900">@{m.name}</span>
                {m.email && (
                  <span className="truncate text-xs text-gray-400">
                    {m.email}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
