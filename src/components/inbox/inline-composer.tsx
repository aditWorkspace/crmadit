'use client';

import { useEffect, useRef, useState } from 'react';
import { Reply } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { EmailComposerBody } from '@/components/leads/email-composer-body';
import type { ThreadDetailLead } from '@/hooks/use-thread-detail';

interface InlineComposerProps {
  threadId: string;
  subject: string;
  lead: ThreadDetailLead | null;
  teamMemberId: string;
  /** Controlled expanded state; if omitted the composer manages its own. */
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  onSent?: () => void;
}

export function InlineComposer({
  threadId,
  subject,
  lead,
  teamMemberId,
  expanded: controlledExpanded,
  onExpandedChange,
  onSent,
}: InlineComposerProps) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const expanded = controlledExpanded ?? uncontrolled;
  const setExpanded = (v: boolean) => {
    if (controlledExpanded === undefined) setUncontrolled(v);
    onExpandedChange?.(v);
  };
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Focus-trap-ish: clicking outside collapses when body is empty.
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      // Keep open — user may be clicking into header buttons. Collapse only via Cancel.
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [expanded]);

  if (!lead || !lead.id || !lead.contact_email) {
    return (
      <div className="border-t border-[color:var(--border-subtle)] bg-white px-4 py-3 text-xs text-gray-500">
        This thread isn&apos;t linked to a lead yet — replies can&apos;t be sent
        from the inbox until it is.
      </div>
    );
  }

  if (!expanded) {
    return (
      <div
        ref={rootRef}
        className="border-t border-[color:var(--border-subtle)] bg-white"
      >
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={cn(
            'flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-gray-500 hover:bg-gray-50 transition-colors'
          )}
        >
          <Reply className="h-4 w-4 text-gray-400" />
          <span>Reply to {lead.contact_name || lead.contact_email}...</span>
          <span className="ml-auto kbd">R</span>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="border-t border-[color:var(--border-subtle)] bg-white"
    >
      <EmailComposerBody
        leadId={lead.id}
        threadId={threadId}
        toEmail={lead.contact_email}
        subject={subject}
        teamMemberId={teamMemberId}
        ownerMemberId={lead.owned_by ?? undefined}
        contactName={lead.contact_name ?? undefined}
        companyName={lead.company_name ?? undefined}
        embedded
        onSent={() => {
          setExpanded(false);
          onSent?.();
        }}
        onCancel={() => setExpanded(false)}
      />
    </div>
  );
}
