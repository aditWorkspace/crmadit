'use client';

import { X } from '@/lib/icons';
import { EmailComposerBody } from './email-composer-body';

interface EmailComposeModalProps {
  leadId: string;
  threadId: string;
  toEmail: string;
  subject: string;
  teamMemberId: string;
  ownerMemberId?: string;
  initialDraft?: string;
  contactName?: string;
  companyName?: string;
  onClose: () => void;
  onSent: (interaction: unknown) => void;
}

/**
 * Thin modal wrapper around EmailComposerBody. Kept for backwards compat —
 * the inbox inline composer uses EmailComposerBody directly.
 */
export function EmailComposeModal({
  leadId,
  threadId,
  toEmail,
  subject,
  teamMemberId,
  ownerMemberId,
  initialDraft,
  contactName,
  companyName,
  onClose,
  onSent,
}: EmailComposeModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-800">New Email</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <EmailComposerBody
          leadId={leadId}
          threadId={threadId}
          toEmail={toEmail}
          subject={subject}
          teamMemberId={teamMemberId}
          ownerMemberId={ownerMemberId}
          initialDraft={initialDraft}
          contactName={contactName}
          companyName={companyName}
          onSent={interaction => {
            onSent(interaction);
            onClose();
          }}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
