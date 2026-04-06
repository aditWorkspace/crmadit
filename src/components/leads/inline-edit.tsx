'use client';

import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface InlineEditProps {
  value: string;
  onSave: (value: string) => Promise<void>;
  placeholder?: string;
  className?: string;
  displayClassName?: string;
  inputClassName?: string;
  type?: 'text' | 'email' | 'url' | 'date' | 'datetime-local';
  multiline?: boolean;
  emptyText?: string;
}

export function InlineEdit({
  value,
  onSave,
  placeholder,
  className,
  displayClassName,
  inputClassName,
  type = 'text',
  multiline = false,
  emptyText = 'Click to edit',
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const handleSave = async () => {
    if (draft === value) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !multiline) { e.preventDefault(); handleSave(); }
    if (e.key === 'Escape') { setDraft(value); setEditing(false); }
  };

  if (editing) {
    const sharedProps = {
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
      onBlur: handleSave,
      onKeyDown: handleKeyDown,
      disabled: saving,
      placeholder,
      className: cn(
        'w-full rounded px-2 py-1 text-sm border border-blue-400 outline-none focus:ring-2 focus:ring-blue-200 bg-white',
        inputClassName
      ),
    };

    return (
      <span className={className}>
        {multiline ? (
          <textarea ref={inputRef as React.RefObject<HTMLTextAreaElement>} {...sharedProps} rows={3} />
        ) : (
          <input ref={inputRef as React.RefObject<HTMLInputElement>} type={type} {...sharedProps} />
        )}
      </span>
    );
  }

  return (
    <span
      className={cn('cursor-pointer group', className)}
      onClick={() => { setDraft(value); setEditing(true); }}
    >
      <span className={cn(
        'rounded px-1 -mx-1 group-hover:bg-gray-100 transition-colors',
        !value && 'text-gray-400 italic',
        displayClassName
      )}>
        {value || emptyText}
      </span>
    </span>
  );
}
