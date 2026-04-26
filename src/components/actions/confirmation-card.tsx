'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, AlertTriangle, Check, X } from '@/lib/icons';

const HARD_CAP = 25;

export interface PreviewRow {
  lead_id: string;
  contact_name: string;
  company_name: string;
  before: string;
  after: string;
}

export interface MutationPreview {
  summary: string;
  affected: PreviewRow[];
  warnings?: string[];
  side_effects?: string[];
}

export type ConfirmationState =
  | { kind: 'pending'; pending_id: string; preview: MutationPreview }
  | { kind: 'confirmed'; result?: unknown }
  | { kind: 'cancelled' }
  | { kind: 'expired' };

interface Props {
  state: ConfirmationState;
  onConfirm: (pending_id: string) => Promise<void>;
  onCancel: (pending_id: string) => Promise<void>;
}

export function ConfirmationCard({ state, onConfirm, onCancel }: Props) {
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState('');

  if (state.kind === 'confirmed') {
    return (
      <div className="border border-emerald-200 bg-emerald-50 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
        <Check className="h-4 w-4 flex-shrink-0" />
        <span>Confirmed and applied.</span>
      </div>
    );
  }
  if (state.kind === 'cancelled') {
    return (
      <div className="border border-gray-200 bg-gray-50 rounded-xl px-4 py-3 text-sm text-gray-500 flex items-center gap-2">
        <X className="h-4 w-4 flex-shrink-0" />
        <span>Cancelled — nothing changed.</span>
      </div>
    );
  }
  if (state.kind === 'expired') {
    return (
      <div className="border border-amber-200 bg-amber-50 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
        <span>This pending action expired. Re-run the request to retry.</span>
      </div>
    );
  }

  const { pending_id, preview } = state;
  const count = preview.affected.length;
  const tooBig = count > HARD_CAP;
  const requiredText = tooBig ? `CONFIRM ${count}` : '';
  const canConfirm = !tooBig || typedConfirm.trim() === requiredText;
  const visible = showAll ? preview.affected : preview.affected.slice(0, 6);

  return (
    <div className="border border-gray-300 rounded-xl overflow-hidden bg-white shadow-sm">
      <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900">{preview.summary}</span>
          {tooBig && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
              bulk
            </span>
          )}
        </div>
        <span className="text-xs text-gray-500">{count} affected</span>
      </div>

      {count === 0 ? (
        <div className="px-4 py-3 text-sm text-gray-500">No leads to change.</div>
      ) : (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-500 bg-gray-50/60 sticky top-0">
              <tr>
                <th className="text-left font-medium px-3 py-1.5">Lead</th>
                <th className="text-left font-medium px-3 py-1.5">Before</th>
                <th className="text-left font-medium px-3 py-1.5">After</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(row => (
                <tr key={row.lead_id} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 text-gray-900">
                    <div className="font-medium">{row.contact_name}</div>
                    <div className="text-gray-400 text-[10px]">{row.company_name}</div>
                  </td>
                  <td className="px-3 py-1.5 text-gray-600">{row.before}</td>
                  <td className="px-3 py-1.5 text-gray-900 font-medium">{row.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {count > visible.length && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full text-center py-1.5 text-xs text-blue-600 hover:bg-gray-50"
            >
              Show {count - visible.length} more
            </button>
          )}
        </div>
      )}

      {(preview.warnings?.length || preview.side_effects?.length) && (
        <div className="px-4 py-2 border-t border-gray-100 space-y-1 bg-amber-50/40">
          {preview.warnings?.map((w, i) => (
            <p key={`w-${i}`} className="text-[11px] text-amber-700 flex items-start gap-1">
              <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" /> {w}
            </p>
          ))}
          {preview.side_effects?.map((s, i) => (
            <p key={`s-${i}`} className="text-[11px] text-gray-500">↳ {s}</p>
          ))}
        </div>
      )}

      {tooBig && count > 0 && (
        <div className="px-4 py-2 border-t border-gray-100 bg-amber-50/40">
          <label className="text-[11px] text-amber-800 block mb-1">
            Bulk action over {HARD_CAP}. Type <span className="font-mono font-semibold">{requiredText}</span> to confirm.
          </label>
          <input
            type="text"
            value={typedConfirm}
            onChange={e => setTypedConfirm(e.target.value)}
            placeholder={requiredText}
            className="w-full text-xs px-2 py-1 border border-amber-200 rounded font-mono focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
        </div>
      )}

      <div className="px-4 py-2.5 border-t border-gray-200 bg-gray-50/60 flex items-center justify-end gap-2">
        <button
          disabled={busy !== null}
          onClick={async () => {
            setBusy('cancel');
            try { await onCancel(pending_id); } finally { setBusy(null); }
          }}
          className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          disabled={busy !== null || !canConfirm || count === 0}
          onClick={async () => {
            setBusy('confirm');
            try { await onConfirm(pending_id); } finally { setBusy(null); }
          }}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
            canConfirm && count > 0 && busy === null
              ? 'bg-gray-900 text-white hover:bg-gray-800'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed',
          )}
        >
          {busy === 'confirm' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Confirm {count > 0 ? count : ''}
        </button>
      </div>
    </div>
  );
}
