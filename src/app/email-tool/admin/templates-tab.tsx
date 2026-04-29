'use client';

import { useEffect, useState, useCallback } from 'react';
import { TemplateEditModal } from '@/components/email-tool/template-edit-modal';

interface Variant {
  id: string;
  founder_id: string;
  label: string;
  subject_template: string;
  body_template: string;
  is_active: boolean;
}

interface Founder { id: string; name: string }

const MIN_ACTIVE_VARIANTS = 2;

export function TemplatesTab() {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [founders, setFounders] = useState<Founder[]>([]);
  const [editing, setEditing] = useState<Variant | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vRes, fRes] = await Promise.all([
        fetch('/api/cron/email-tool/templates').then(r => r.json() as Promise<{ variants?: Variant[] }>),
        fetch('/api/team/members').then(r => r.json() as Promise<{ members?: Founder[] }>),
      ]);
      setVariants(vRes.variants ?? []);
      setFounders(fRes.members ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="text-sm text-gray-500 p-8 text-center">Loading…</div>;
  if (error) return <div className="text-sm text-red-600 p-8 text-center">Error: {error}</div>;

  return (
    <div className="space-y-6">
      {founders.map(founder => {
        const fVariants = variants.filter(v => v.founder_id === founder.id);
        const activeCount = fVariants.filter(v => v.is_active).length;
        return (
          <section key={founder.id} className="border border-gray-200 rounded-lg p-4 bg-white">
            <header className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{founder.name}</h2>
              <button
                onClick={() => setCreatingFor(founder.id)}
                className="px-3 py-1 bg-blue-500 text-white rounded text-sm font-medium hover:bg-blue-600"
              >
                + New Variant
              </button>
            </header>
            {activeCount < MIN_ACTIVE_VARIANTS && (
              <div className="bg-yellow-50 border border-yellow-200 rounded p-3 mb-4 text-sm text-yellow-800">
                ⚠ Only {activeCount} active variant{activeCount === 1 ? '' : 's'}. At least {MIN_ACTIVE_VARIANTS} required before campaigns can run for {founder.name}.
              </div>
            )}
            {fVariants.length === 0 ? (
              <p className="text-gray-500 text-sm italic">No variants yet.</p>
            ) : (
              <ul className="space-y-2">
                {fVariants.map(v => (
                  <li
                    key={v.id}
                    className={`border border-gray-200 rounded p-3 ${!v.is_active ? 'opacity-50' : ''}`}
                  >
                    <div className="flex justify-between items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-green-600">{v.is_active ? '✓' : '✗'}</span>
                          <span className="font-medium">{v.label}</span>
                        </div>
                        <div className="text-sm text-gray-700">
                          <span className="text-gray-500">Subject: </span>
                          <span className="font-mono">{v.subject_template}</span>
                        </div>
                        <div className="text-xs text-gray-500 mt-1 truncate">
                          {v.body_template.slice(0, 80)}
                          {v.body_template.length > 80 ? '…' : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => setEditing(v)}
                        className="text-blue-600 text-sm hover:underline shrink-0"
                      >
                        Edit
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {editing && (
        <TemplateEditModal
          variant={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {creatingFor && (
        <TemplateEditModal
          variant={{
            id: '',
            founder_id: creatingFor,
            label: '',
            subject_template: '',
            body_template: '',
            is_active: true,
          }}
          onClose={() => setCreatingFor(null)}
          onSaved={() => { setCreatingFor(null); load(); }}
        />
      )}
    </div>
  );
}
