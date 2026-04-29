'use client';

import { useState, useMemo, useEffect, useRef } from 'react';

interface ParsedRow {
  email: string;
  first_name?: string;
  company?: string;
}

interface ValidationReport {
  valid_count: number;
  blacklisted_emails: string[];
  dead_lead_emails: string[];
  active_lead_owners: Record<string, string>;
  malformed: string[];
  would_insert: number;
}

interface Props {
  onClose: () => void;
  onUploaded: () => void;
}

function parseInput(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows: ParsedRow[] = [];
  for (const line of lines) {
    const cols = line.split(/[,\t]/).map(c => c.trim());
    if (!cols[0]) continue;
    rows.push({
      email: cols[0].toLowerCase(),
      first_name: cols[1] || undefined,
      company: cols[2] || undefined,
    });
  }
  return rows;
}

// Build a list of the next N weekdays (Mon–Fri) in PT, returning
// { date: 'YYYY-MM-DD', label: 'Mon May 4' } for each.
function nextWeekdays(count: number): Array<{ date: string; label: string }> {
  const out: Array<{ date: string; label: string }> = [];
  const ymdFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const labelFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const dowFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
  });
  let i = 0;
  let added = 0;
  // Start from tomorrow (i=1) so today's slot — already past or in flight — is excluded.
  while (added < count && i < 14) {
    const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
    const dow = dowFmt.format(d);
    if (dow !== 'Sat' && dow !== 'Sun' && i > 0) {
      out.push({ date: ymdFmt.format(d), label: labelFmt.format(d) });
      added++;
    }
    i++;
  }
  return out;
}

const SLOT_TIMES_BY_DOW: Record<string, string> = {
  Mon: '5:00 AM PT',
  Tue: '5:30 AM PT',
  Wed: '6:00 AM PT',
  Thu: '6:30 AM PT',
  Fri: '7:00 AM PT',
};

function dowOf(yyyymmdd: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
  }).format(new Date(`${yyyymmdd}T12:00:00-08:00`));
}

export function PriorityUploadModal({ onClose, onUploaded }: Props) {
  const weekdayOptions = useMemo(() => nextWeekdays(7), []);
  const [pasteText, setPasteText] = useState('');
  const [scheduledDate, setScheduledDate] = useState(weekdayOptions[0]?.date ?? '');
  const [notes, setNotes] = useState('');
  const [useLeadOwner, setUseLeadOwner] = useState(true);
  const [overrideBlacklist, setOverrideBlacklist] = useState(false);
  const [overrideDeadLeads, setOverrideDeadLeads] = useState(false);

  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [validating, setValidating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);

  const parsed = useMemo(() => parseInput(pasteText), [pasteText]);

  // C16: Escape-to-close + autofocus the date select on mount
  const dateSelectRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    dateSelectRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Re-run validation when overrides change in the review step.
  useEffect(() => {
    if (step !== 'review' || parsed.length === 0) return;
    void validate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [overrideBlacklist, overrideDeadLeads, useLeadOwner]);

  async function validate() {
    setValidating(true);
    setError(null);
    const res = await fetch('/api/cron/email-tool/priority', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rows: parsed,
        scheduled_for_date: scheduledDate,
        notes: notes || undefined,
        confirmed: false,
        override_blacklist: overrideBlacklist,
        override_dead_leads: overrideDeadLeads,
        use_lead_owner: useLeadOwner,
      }),
    });
    setValidating(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? 'validation failed');
      return;
    }
    setReport(data.validation as ValidationReport);
    setStep('review');
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    const res = await fetch('/api/cron/email-tool/priority', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rows: parsed,
        scheduled_for_date: scheduledDate,
        notes: notes || undefined,
        confirmed: true,
        override_blacklist: overrideBlacklist,
        override_dead_leads: overrideDeadLeads,
        use_lead_owner: useLeadOwner,
      }),
    });
    setSubmitting(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? 'upload failed');
      return;
    }
    setSuccess(`Inserted ${data.inserted} rows.`);
    setTimeout(onUploaded, 1500);
  }

  const slotLabel = scheduledDate
    ? SLOT_TIMES_BY_DOW[dowOf(scheduledDate)] ?? '?'
    : '?';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-xl font-bold mb-4">
          Upload Priority Batch {step === 'review' && <span className="text-sm font-normal text-gray-500">— review</span>}
        </h2>

        {step === 'edit' && (
          <>
            <label className="block mb-3">
              <span className="text-sm font-medium">Schedule for</span>
              <select
                ref={dateSelectRef}
                value={scheduledDate}
                onChange={e => setScheduledDate(e.target.value)}
                className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm"
              >
                {weekdayOptions.map(opt => (
                  <option key={opt.date} value={opt.date}>
                    {opt.label} ({SLOT_TIMES_BY_DOW[dowOf(opt.date)] ?? '?'})
                  </option>
                ))}
              </select>
            </label>

            <label className="block mb-3">
              <span className="text-sm font-medium">Batch label / notes (optional)</span>
              <input
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. YC partner contacts after demo day"
                className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm"
              />
            </label>

            <label className="block mb-3">
              <span className="text-sm font-medium">
                Recipients (CSV/paste, format: <code>email,first_name,company</code> per line)
              </span>
              <textarea
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                rows={10}
                placeholder={'pat@acme.com,Pat,Acme\njordan@stripe.com,Jordan,Stripe'}
                className="mt-1 w-full border border-gray-300 rounded px-2 py-1 font-mono text-xs"
              />
              <div className="text-xs text-gray-500 mt-1">
                {parsed.length} row{parsed.length === 1 ? '' : 's'} parsed
              </div>
            </label>

            <label className="flex items-center gap-2 mb-4 text-sm">
              <input type="checkbox" checked={useLeadOwner} onChange={e => setUseLeadOwner(e.target.checked)} />
              Use lead owner for matched CRM contacts (round-robin for the rest)
            </label>

            {error && (
              <div className="text-red-600 text-sm mb-3 bg-red-50 border border-red-200 rounded p-2">{error}</div>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
              <button
                disabled={validating || parsed.length === 0}
                onClick={validate}
                className="px-3 py-1 bg-blue-500 text-white rounded text-sm disabled:bg-gray-300"
              >
                {validating ? 'Validating…' : 'Validate'}
              </button>
            </div>
          </>
        )}

        {step === 'review' && report && (
          <>
            <div className="bg-gray-50 border border-gray-200 rounded p-3 mb-4 text-sm space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-500">Schedule:</span>
                <span className="font-medium">{scheduledDate} ({slotLabel})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Total rows pasted:</span>
                <span>{parsed.length}</span>
              </div>
              {report.malformed.length > 0 && (
                <div className="flex justify-between text-red-600">
                  <span>Malformed emails:</span>
                  <span>{report.malformed.length}</span>
                </div>
              )}
              {report.blacklisted_emails.length > 0 && (
                <div className="border-t border-gray-200 pt-2">
                  <div className="flex justify-between text-yellow-700 mb-1">
                    <span>Already blacklisted:</span>
                    <span>{report.blacklisted_emails.length}</span>
                  </div>
                  <details>
                    <summary className="text-xs text-blue-600 cursor-pointer">Show emails</summary>
                    <ul className="text-xs mt-1 ml-4 list-disc">
                      {report.blacklisted_emails.slice(0, 20).map(e => (
                        <li key={e} className="font-mono">{e}</li>
                      ))}
                      {report.blacklisted_emails.length > 20 && (
                        <li className="text-gray-500">… and {report.blacklisted_emails.length - 20} more</li>
                      )}
                    </ul>
                  </details>
                  <label className="flex items-center gap-2 text-xs mt-1">
                    <input type="checkbox" checked={overrideBlacklist} onChange={e => setOverrideBlacklist(e.target.checked)} />
                    Send anyway (override blacklist)
                  </label>
                </div>
              )}
              {report.dead_lead_emails.length > 0 && (
                <div className="border-t border-gray-200 pt-2">
                  <div className="flex justify-between text-red-700 mb-1">
                    <span>Match leads in <code>stage=&apos;dead&apos;</code>:</span>
                    <span>{report.dead_lead_emails.length}</span>
                  </div>
                  <details>
                    <summary className="text-xs text-blue-600 cursor-pointer">Show emails</summary>
                    <ul className="text-xs mt-1 ml-4 list-disc">
                      {report.dead_lead_emails.slice(0, 20).map(e => (
                        <li key={e} className="font-mono">{e}</li>
                      ))}
                      {report.dead_lead_emails.length > 20 && (
                        <li className="text-gray-500">… and {report.dead_lead_emails.length - 20} more</li>
                      )}
                    </ul>
                  </details>
                  <label className="flex items-center gap-2 text-xs mt-1">
                    <input type="checkbox" checked={overrideDeadLeads} onChange={e => setOverrideDeadLeads(e.target.checked)} />
                    Send anyway (override dead-lead block)
                  </label>
                </div>
              )}
              {Object.keys(report.active_lead_owners).length > 0 && (
                <div className="border-t border-gray-200 pt-2">
                  <div className="flex justify-between text-blue-700">
                    <span>Match active CRM leads:</span>
                    <span>{Object.keys(report.active_lead_owners).length}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {useLeadOwner
                      ? 'Will be assigned to existing lead owner.'
                      : '(Lead-owner attribution disabled — round-robin instead.)'}
                  </div>
                </div>
              )}
              <div className="border-t border-gray-200 pt-2 flex justify-between font-semibold">
                <span>Will insert:</span>
                <span>{report.would_insert} rows</span>
              </div>
            </div>

            {error && (
              <div className="text-red-600 text-sm mb-3 bg-red-50 border border-red-200 rounded p-2">{error}</div>
            )}
            {success && (
              <div className="text-green-700 text-sm mb-3 bg-green-50 border border-green-200 rounded p-2">{success}</div>
            )}

            <div className="flex justify-between gap-2">
              <button onClick={() => setStep('edit')} className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800">
                Back to edit
              </button>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
                <button
                  disabled={submitting || report.would_insert === 0}
                  onClick={submit}
                  className="px-3 py-1 bg-blue-500 text-white rounded text-sm disabled:bg-gray-300"
                >
                  {submitting ? 'Uploading…' : `Schedule ${report.would_insert} rows`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
