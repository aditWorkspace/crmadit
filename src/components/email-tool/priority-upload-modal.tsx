'use client';

import { useState, useMemo } from 'react';

interface ParsedRow {
  email: string;
  first_name?: string;
  company?: string;
}

interface Props {
  onClose: () => void;
  onUploaded: () => void;
}

// Parse CSV-or-paste input into rows.
// Accepts:
//   email
//   email,first_name
//   email,first_name,company
// Newline-separated. Comma OR tab as field separator. First column is always email.
function parseInput(text: string): { rows: ParsedRow[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(/[,\t]/).map(c => c.trim());
    if (!cols[0]) continue;
    rows.push({
      email: cols[0].toLowerCase(),
      first_name: cols[1] || undefined,
      company: cols[2] || undefined,
    });
  }
  return { rows, errors };
}

// Default: tomorrow's date in YYYY-MM-DD (PT)
function tomorrowPtDate(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function PriorityUploadModal({ onClose, onUploaded }: Props) {
  const [pasteText, setPasteText] = useState('');
  const [scheduledDate, setScheduledDate] = useState(tomorrowPtDate());
  const [notes, setNotes] = useState('');
  const [overrideBlacklist, setOverrideBlacklist] = useState(false);
  const [useLeadOwner, setUseLeadOwner] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const parsed = useMemo(() => parseInput(pasteText), [pasteText]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    const res = await fetch('/api/cron/email-tool/priority', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rows: parsed.rows,
        scheduled_for_date: scheduledDate,
        notes: notes || undefined,
        override_blacklist: overrideBlacklist,
        use_lead_owner: useLeadOwner,
      }),
    });
    setSubmitting(false);
    if (res.ok) {
      const data = await res.json();
      setSuccess(`Inserted ${data.inserted}; skipped ${data.skipped_blacklisted} already-blacklisted.`);
      setTimeout(onUploaded, 1500);
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error ?? 'upload failed');
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-xl font-bold mb-4">Upload Priority Batch</h2>

        <label className="block mb-3">
          <span className="text-sm font-medium">Schedule for date (PT, YYYY-MM-DD)</span>
          <input
            value={scheduledDate}
            onChange={e => setScheduledDate(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded px-2 py-1 font-mono text-sm"
            placeholder="2026-05-04"
          />
        </label>

        <label className="block mb-3">
          <span className="text-sm font-medium">Notes / batch label (optional)</span>
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
            {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} parsed
            {parsed.errors.length > 0 && ` · ${parsed.errors.length} errors`}
          </div>
        </label>

        <div className="space-y-2 mb-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useLeadOwner} onChange={e => setUseLeadOwner(e.target.checked)} />
            Use lead owner for matched CRM contacts (round-robin for the rest)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={overrideBlacklist} onChange={e => setOverrideBlacklist(e.target.checked)} />
            Override blacklist (send even if email is already blacklisted)
          </label>
        </div>

        {error && (
          <div className="text-red-600 text-sm mb-3 bg-red-50 border border-red-200 rounded p-2">
            {error}
          </div>
        )}
        {success && (
          <div className="text-green-700 text-sm mb-3 bg-green-50 border border-green-200 rounded p-2">
            {success}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || parsed.rows.length === 0}
            onClick={submit}
            className="px-3 py-1 bg-blue-500 text-white rounded text-sm disabled:bg-gray-300"
          >
            {submitting ? 'Uploading...' : `Upload ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
