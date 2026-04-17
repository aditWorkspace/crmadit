'use client';

import { useState } from 'react';
import { HelpCircle, X, ChevronDown, ChevronRight } from '@/lib/icons';

const GLOSSARY: { term: string; definition: string; example?: string }[] = [
  {
    term: 'In Dialogue',
    definition: 'They replied to your cold outreach — you\'re now in active email conversation. Respond within 4 hours.',
    example: 'They said "sounds interesting, tell me more" → stage moves to In Dialogue.',
  },
  {
    term: 'Scheduling Call',
    definition: 'Going back and forth to find a time for the discovery call. No confirmed slot yet.',
    example: '"Does Tuesday 2pm work?" "How about Thursday?" — that\'s Scheduling Call.',
  },
  {
    term: 'Call Scheduled',
    definition: 'Discovery call is confirmed on the calendar. Lead auto-elevates to High priority.',
  },
  {
    term: 'Discovery Call Done',
    definition: 'The first call happened. Send product access/demo within 6 hours.',
  },
  {
    term: 'Demo Sent',
    definition: 'You\'ve sent product access. Now schedule a feedback call to hear what they think.',
  },
  {
    term: 'Feedback Call',
    definition: 'Second call — they give you feedback on using the product. Goal is to lock in a weekly cadence.',
  },
  {
    term: 'Weekly Calls',
    definition: 'Recurring relationship. You\'re doing weekly calls with this person. Keep the cadence going.',
  },
  {
    term: 'Paused',
    definition: 'Mutually agreed to revisit later (e.g. "reach out in Q2"). Previous stage is saved to restore from.',
  },
  {
    term: 'Dead',
    definition: 'Hard no — not interested or not a fit. All pending follow-ups are dismissed.',
  },
  {
    term: 'Stale',
    definition: 'No contact in longer than the stage threshold. In Dialogue → 4h. Scheduling → 48h. Discovery Call Done → 6h. Demo Sent → 3 days. Feedback/Weekly → 7 days.',
  },
  {
    term: 'Heat Score',
    definition: 'AI-scored 0–100 estimate of how likely this lead is to convert. Updated every 2 hours. Red flame ≥70, orange ≥40, gray below.',
  },
  {
    term: 'Auto-followup',
    definition: 'If a lead goes quiet for 48+ hours and the last email was yours, the system auto-sends a follow-up via Gmail. Only runs during In Dialogue and Scheduling Call — never after a call is booked.',
  },
  {
    term: 'AI Next Action',
    definition: 'Qwen AI reads the last 5 interactions for this lead and suggests a specific, actionable next step. Refreshes every 2 hours or on demand.',
  },
  {
    term: 'Priority',
    definition: 'Critical / High / Medium / Low. Entering Scheduled auto-promotes a lead to High. You can always override manually.',
  },
  {
    term: 'Action Items',
    definition: 'To-dos scoped to a specific lead. Can be manually added, AI-extracted from call transcripts, or auto-generated when a stage changes.',
  },
  {
    term: 'Send as Founder',
    definition: 'Any founder can compose or reply to any lead\'s email thread using any other connected founder\'s Gmail account. Useful for covering for each other or co-managing leads.',
  },
  {
    term: 'Calendar Sync',
    definition: 'Scans your Google Calendar for meetings where all three founders are invited — those are Proxi calls. Imports the meeting as a lead (or links it to an existing one) and searches your Gmail for any email thread with that contact.',
  },
];

function Term({ item }: { item: typeof GLOSSARY[0] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        <span className="text-sm font-medium text-gray-800">{item.term}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />}
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-1.5">
          <p className="text-sm text-gray-600">{item.definition}</p>
          {item.example && (
            <p className="text-xs text-gray-400 italic">e.g. {item.example}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function HelpPanel() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
        title="Glossary & Help"
      >
        <HelpCircle className="h-4 w-4" />
        <span className="hidden lg:inline">Help</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setOpen(false)} />
          <div className="fixed right-0 top-0 bottom-0 z-50 w-80 bg-white shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
            <div className="flex items-center justify-between px-4 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Glossary & Help</h2>
                <p className="text-xs text-gray-500 mt-0.5">What does everything mean?</p>
              </div>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              {GLOSSARY.map(item => <Term key={item.term} item={item} />)}
            </div>
          </div>
        </>
      )}
    </>
  );
}
