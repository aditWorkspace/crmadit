'use client';

import { FollowUp } from '@/types';
import { formatRelativeTime, cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useSession } from '@/hooks/use-session';
import { Copy, CheckCheck, Clock, Phone, PhoneOff, Upload, MessageCircle, CalendarPlus, HelpCircle } from '@/lib/icons';
import Link from 'next/link';

interface PendingFollowupsProps {
  followUps: FollowUp[];
  onUpdate: (id: string) => void;
}

export function PendingFollowups({ followUps, onUpdate }: PendingFollowupsProps) {
  const { user } = useSession();

  const handleAction = async (id: string, action: string) => {
    if (!user) return;
    const res = await fetch(`/api/follow-ups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-team-member-id': user.team_member_id },
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      onUpdate(id);
      if (action === 'confirm_call') toast.success('Call confirmed — stage moved to Call Completed');
      else if (action === 'noshow_call') toast.info('Marked as no-show — lead stays scheduled');
      else if (action === 'complete') toast.success('Follow-up marked done');
    } else {
      toast.error('Failed to update follow-up');
    }
  };

  const copyMessage = (msg: string) => {
    navigator.clipboard.writeText(msg);
    toast.success('Copied to clipboard');
  };

  if (followUps.length === 0) {
    return <p className="text-sm text-gray-400 py-4">No pending follow-ups.</p>;
  }

  return (
    <div className="space-y-3">
      {followUps.slice(0, 5).map(f => {
        const isOverdue = new Date(f.due_at) < new Date();
        const isCallConfirmation = f.type === 'call_confirmation';
        const isPostCallFollowup = f.type === 'post_call_followup';
        const isManualReview = f.type === 'first_reply_manual_review';
        // Responder flags "needs founder" cases (calendly_sent / question_only)
        // by prefixing the reason text. Sub-classify so we can show the right
        // verb (log in and book vs answer the question).
        const needsFounder = isManualReview && f.reason?.startsWith('NEEDS_FOUNDER:') === true;
        const isCalendarNudge = needsFounder && f.reason?.includes('calendly_sent') === true;
        const isQuestionNudge = needsFounder && f.reason?.includes('question_only') === true;
        const lead = f.lead as { id: string; contact_name: string; company_name: string } | undefined;

        return (
          <div key={f.id} className={cn(
            'rounded-lg border p-3 space-y-2',
            isCallConfirmation
              ? 'border-indigo-200 bg-indigo-50/40'
              : isPostCallFollowup
                ? 'border-indigo-200 bg-indigo-50/40'
                : needsFounder
                  ? 'border-rose-300 bg-rose-50/50'
                  : isManualReview
                    ? 'border-amber-200 bg-amber-50/40'
                    : isOverdue
                    ? 'border-red-200 bg-red-50/30'
                    : 'border-gray-100'
          )}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-0.5">
                  {isCallConfirmation
                    ? <Phone className="h-3 w-3 text-indigo-400" />
                    : isPostCallFollowup
                      ? <Upload className="h-3 w-3 text-indigo-400" />
                      : isCalendarNudge
                        ? <CalendarPlus className="h-3 w-3 text-rose-500" />
                        : isQuestionNudge
                          ? <HelpCircle className="h-3 w-3 text-rose-500" />
                          : isManualReview
                            ? <MessageCircle className="h-3 w-3 text-amber-500" />
                            : <Clock className="h-3 w-3" />
                  }
                  <span className={cn(
                    isCallConfirmation ? 'text-indigo-600 font-medium' :
                    isPostCallFollowup ? 'text-indigo-600 font-medium' :
                    needsFounder ? 'text-rose-600 font-medium' :
                    isManualReview ? 'text-amber-600 font-medium' :
                    isOverdue ? 'text-red-500 font-medium' : ''
                  )}>
                    {isCallConfirmation
                      ? 'Call check-in'
                      : isPostCallFollowup
                        ? 'Transcript needed'
                        : isCalendarNudge
                          ? 'Needs founder: book the slot'
                          : isQuestionNudge
                            ? 'Needs founder: answer question'
                            : isManualReview
                              ? 'Reply needs review'
                              : isOverdue ? `Overdue ${formatRelativeTime(f.due_at)}` : `Due ${formatRelativeTime(f.due_at)}`
                    }
                  </span>
                </div>
                <p className="text-sm font-medium text-gray-800">
                  {isPostCallFollowup && lead ? (
                    <Link href={`/leads/${lead.id}?upload=true`} className="hover:text-indigo-600">
                      Upload your transcript for {lead.contact_name}
                    </Link>
                  ) : lead ? (
                    <Link href={`/leads/${lead.id}`} className="hover:text-blue-600">
                      {lead.contact_name} · {lead.company_name}
                    </Link>
                  ) : '—'}
                </p>
                {f.reason && !isPostCallFollowup && <p className="text-xs text-gray-500 mt-0.5">{f.reason}</p>}
              </div>
            </div>

            {/* Manual review — prospect replied and AI routed to human.
                needsFounder rows (calendly_sent / question_only) get a red
                CTA that reads differently; everything else stays amber. */}
            {isManualReview && lead ? (
              <div className="flex items-center gap-2">
                <Link
                  href={`/leads/${lead.id}`}
                  className={cn(
                    'flex items-center gap-1.5 text-xs text-white rounded px-2.5 py-1 transition-colors',
                    needsFounder
                      ? 'bg-rose-600 hover:bg-rose-700'
                      : 'bg-amber-600 hover:bg-amber-700'
                  )}
                >
                  {isCalendarNudge ? (
                    <>
                      <CalendarPlus className="h-3 w-3" />
                      Book the slot
                    </>
                  ) : isQuestionNudge ? (
                    <>
                      <HelpCircle className="h-3 w-3" />
                      Answer
                    </>
                  ) : (
                    <>
                      <MessageCircle className="h-3 w-3" />
                      Review Reply
                    </>
                  )}
                </Link>
                <button
                  onClick={() => handleAction(f.id, 'complete')}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2.5 py-1"
                >
                  <CheckCheck className="h-3 w-3" />
                  Done
                </button>
              </div>
            ) : isCallConfirmation ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleAction(f.id, 'confirm_call')}
                  className="flex items-center gap-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded px-2.5 py-1 transition-colors"
                >
                  <Phone className="h-3 w-3" />
                  Yes, happened
                </button>
                <button
                  onClick={() => handleAction(f.id, 'noshow_call')}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2.5 py-1"
                >
                  <PhoneOff className="h-3 w-3" />
                  No-show
                </button>
              </div>
            ) : isPostCallFollowup && lead ? (
              <div className="flex items-center gap-2">
                <Link
                  href={`/leads/${lead.id}?upload=true`}
                  className="flex items-center gap-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded px-2.5 py-1 transition-colors"
                >
                  <Upload className="h-3 w-3" />
                  Upload Transcript
                </Link>
                <button
                  onClick={() => handleAction(f.id, 'complete')}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2.5 py-1"
                >
                  <CheckCheck className="h-3 w-3" />
                  Done
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {f.suggested_message && (
                  <button
                    onClick={() => copyMessage(f.suggested_message!)}
                    className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1"
                  >
                    <Copy className="h-3 w-3" />
                    Copy
                  </button>
                )}
                <button
                  onClick={() => handleAction(f.id, 'complete')}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1"
                >
                  <CheckCheck className="h-3 w-3" />
                  Done
                </button>
              </div>
            )}
          </div>
        );
      })}
      {followUps.length > 5 && (
        <Link href="/follow-ups" className="text-xs text-blue-500 hover:underline">
          +{followUps.length - 5} more →
        </Link>
      )}
    </div>
  );
}
