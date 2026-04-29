'use client';

import { useState, useMemo } from 'react';
import { renderTemplate } from '@/lib/email-tool/render-template';
import { lintTemplate, type LintIssue } from '@/lib/email-tool/lint';

interface Variant {
  id: string;
  founder_id: string;
  label: string;
  subject_template: string;
  body_template: string;
  is_active: boolean;
}

interface Props {
  variant: Variant;
  onClose: () => void;
  onSaved: () => void;
}

const SAMPLE_FIRST_NAME = 'Pat';
const SAMPLE_COMPANY = 'Acme Corp';
const SAMPLE_FOUNDER = 'Adit';

export function TemplateEditModal({ variant, onClose, onSaved }: Props) {
  const isCreate = variant.id === '';
  const [label, setLabel] = useState(variant.label);
  const [subject, setSubject] = useState(variant.subject_template);
  const [body, setBody] = useState(variant.body_template);
  const [isActive, setIsActive] = useState(variant.is_active);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);

  const lint = useMemo(
    () => lintTemplate({ subject_template: subject, body_template: body }),
    [subject, body]
  );

  const preview = useMemo(
    () => {
      // previewKey forces a re-render of spintax without changing the template
      void previewKey;
      return renderTemplate({
        subject_template: subject,
        body_template: body,
        first_name: SAMPLE_FIRST_NAME,
        company: SAMPLE_COMPANY,
        founder_name: SAMPLE_FOUNDER,
      });
    },
    [subject, body, previewKey]
  );

  async function save(overrideWarnings: boolean = false): Promise<void> {
    setSubmitting(true);
    setError(null);
    const url = isCreate
      ? '/api/cron/email-tool/templates'
      : `/api/cron/email-tool/templates/${variant.id}`;
    const method = isCreate ? 'POST' : 'PATCH';
    const payload: Record<string, unknown> = {
      label,
      subject_template: subject,
      body_template: body,
      override_warnings: overrideWarnings,
    };
    if (isCreate) {
      payload.founder_id = variant.founder_id;
    } else {
      payload.is_active = isActive;
    }
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSubmitting(false);
    if (res.ok) { onSaved(); return; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.issues?.warnings?.length > 0) {
      const warningMessages = (data.issues.warnings as LintIssue[]).map(w => `• ${w.message}`).join('\n');
      if (typeof window !== 'undefined' && window.confirm(`Save with warnings?\n\n${warningMessages}`)) {
        return save(true);
      }
      return;
    }
    setError(data.error ?? 'save failed');
  }

  function insertVariable(tag: string): void {
    setBody(b => b + tag);
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg max-w-3xl w-full max-h-[90vh] overflow-auto p-6"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold mb-4">
          {isCreate ? 'New Variant' : 'Edit Variant'}
        </h2>

        <label className="block mb-3">
          <span className="text-sm font-medium">Label</span>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="e.g. Adit v2"
            className="mt-1 w-full border border-gray-300 rounded px-2 py-1"
          />
        </label>

        <label className="block mb-3">
          <span className="text-sm font-medium">Subject</span>
          <input
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="product prioritization at {{company}}"
            className="mt-1 w-full border border-gray-300 rounded px-2 py-1 font-mono text-sm"
          />
        </label>

        <label className="block mb-2">
          <span className="text-sm font-medium">Body</span>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={12}
            placeholder="Hi {{first_name}}, ..."
            className="mt-1 w-full border border-gray-300 rounded px-2 py-1 font-mono text-sm"
          />
        </label>

        <div className="text-xs text-gray-500 mb-4 flex items-center gap-2">
          <span>Insert variable:</span>
          {['{{first_name}}', '{{company}}', '{{founder_name}}'].map(tag => (
            <button
              key={tag}
              type="button"
              onClick={() => insertVariable(tag)}
              className="font-mono bg-gray-100 hover:bg-gray-200 px-2 py-0.5 rounded"
            >
              {tag}
            </button>
          ))}
        </div>

        {!isCreate && (
          <label className="flex items-center gap-2 mb-4 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={e => setIsActive(e.target.checked)}
            />
            Active (counts toward founder&apos;s minimum-2 requirement)
          </label>
        )}

        <div className="bg-gray-50 border border-gray-200 rounded p-3 mb-3">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-semibold">Live Preview (sample data)</span>
            <button
              type="button"
              onClick={() => setPreviewKey(k => k + 1)}
              className="text-xs text-blue-600 hover:underline"
            >
              Re-roll spintax
            </button>
          </div>
          <div className="text-sm">
            <strong>Subject:</strong> {preview.subject || <em className="text-gray-400">(empty)</em>}
          </div>
          <pre className="text-sm mt-2 whitespace-pre-wrap font-sans">
            {preview.body || <em className="text-gray-400">(empty)</em>}
          </pre>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded p-3 mb-3 text-sm">
          {lint.blockers.length === 0 && lint.warnings.length === 0 ? (
            <span className="text-green-600">&#10003; No issues</span>
          ) : (
            <>
              {lint.blockers.map(b => (
                <div key={b.code} className="text-red-600">&#128721; {b.message}</div>
              ))}
              {lint.warnings.map(w => (
                <div key={w.code} className="text-yellow-700">&#9888; {w.message}</div>
              ))}
            </>
          )}
        </div>

        {error && (
          <div className="text-red-600 text-sm mb-3 bg-red-50 border border-red-200 rounded p-2">
            {error}
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
            disabled={submitting || lint.blockers.length > 0}
            onClick={() => save(false)}
            className="px-3 py-1 bg-blue-500 text-white rounded text-sm disabled:bg-gray-300"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
