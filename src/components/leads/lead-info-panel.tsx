'use client';

import { useState } from 'react';
import { Lead, TeamMember } from '@/types';
import { InlineEdit } from './inline-edit';
import { PRIORITY_LABELS, PRIORITY_COLORS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { ExternalLink, X } from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

interface LeadInfoPanelProps {
  lead: Lead;
  members: TeamMember[];
  onUpdate: (updates: Partial<Lead>) => Promise<void>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{title}</h4>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs text-gray-400 w-20 flex-shrink-0 pt-0.5">{label}</span>
      <div className="flex-1 min-w-0 text-sm text-gray-700">{children}</div>
    </div>
  );
}

export function LeadInfoPanel({ lead, members, onUpdate }: LeadInfoPanelProps) {
  const [newTag, setNewTag] = useState('');

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || lead.tags.includes(trimmed)) return;
    onUpdate({ tags: [...lead.tags, trimmed] });
  };

  const removeTag = (tag: string) => {
    onUpdate({ tags: lead.tags.filter(t => t !== tag) });
  };

  return (
    <div className="space-y-5">
      {lead.pinned_note && (
        <div className="rounded-lg bg-yellow-50 border border-yellow-200 p-3">
          <p className="text-xs font-semibold text-yellow-700 mb-1">📌 Pinned Note</p>
          <p className="text-sm text-yellow-800">{lead.pinned_note}</p>
        </div>
      )}

      <Section title="Contact">
        <Field label="Email">
          <InlineEdit value={lead.contact_email} onSave={v => onUpdate({ contact_email: v })} type="email" />
        </Field>
        <Field label="LinkedIn">
          <div className="flex items-center gap-1">
            <InlineEdit value={lead.contact_linkedin || ''} onSave={v => onUpdate({ contact_linkedin: v })} emptyText="Add LinkedIn" />
            {lead.contact_linkedin && (
              <a href={lead.contact_linkedin} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-blue-500">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </Field>
      </Section>

      <Section title="Company">
        <Field label="URL">
          <div className="flex items-center gap-1">
            <InlineEdit value={lead.company_url || ''} onSave={v => onUpdate({ company_url: v })} type="url" emptyText="Add URL" />
            {lead.company_url && (
              <a href={lead.company_url} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-blue-500">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </Field>
        <Field label="Stage">
          <InlineEdit value={lead.company_stage || ''} onSave={v => onUpdate({ company_stage: v })} emptyText="e.g. Series B" />
        </Field>
        <Field label="Size">
          <InlineEdit value={lead.company_size || ''} onSave={v => onUpdate({ company_size: v })} emptyText="e.g. 10-50" />
        </Field>
      </Section>

      <Section title="Ownership">
        <Field label="Owned by">
          <Select value={lead.owned_by} onValueChange={(v: string | null) => { if (v) onUpdate({ owned_by: v }); }}>
            <SelectTrigger className="h-6 border-0 p-0 text-sm text-gray-700 hover:bg-gray-100 focus:ring-0">
              <SelectValue>{(lead.owned_by_member as TeamMember | undefined)?.name || '—'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {members.map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Sourced by">
          <span className="text-sm text-gray-600">
            {(lead.sourced_by_member as TeamMember | undefined)?.name || '—'}
          </span>
        </Field>
      </Section>

      <Section title="Priority">
        <div className="flex gap-2 flex-wrap">
          {(['critical', 'high', 'medium', 'low'] as const).map(p => (
            <button
              key={p}
              onClick={() => onUpdate({ priority: p })}
              className={cn(
                'flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border transition-colors',
                lead.priority === p
                  ? 'border-gray-400 bg-gray-100 text-gray-700 font-medium'
                  : 'border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-600'
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', PRIORITY_COLORS[p])} />
              {PRIORITY_LABELS[p]}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Tags">
        <div className="flex flex-wrap gap-1.5 mb-2">
          {lead.tags.map(tag => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700">
              {tag}
              <button onClick={() => removeTag(tag)} className="hover:text-red-500 transition-colors">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <input
          value={newTag}
          onChange={e => setNewTag(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { addTag(newTag); setNewTag(''); }
            if (e.key === ',') { e.preventDefault(); addTag(newTag); setNewTag(''); }
          }}
          placeholder="Add tag..."
          className="text-xs w-full border-b border-gray-200 pb-0.5 outline-none bg-transparent text-gray-600 placeholder-gray-300 focus:border-blue-400"
        />
      </Section>
    </div>
  );
}
