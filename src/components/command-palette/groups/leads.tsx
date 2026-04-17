'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { User } from '@/lib/icons';
import { useSession } from '@/hooks/use-session';

type LeadHit = {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  stage?: string | null;
  contact_email?: string | null;
};

type Props = {
  query: string;
  onSelect: () => void;
};

export function LeadsGroup({ query, onSelect }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const [results, setResults] = useState<LeadHit[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !user) {
      setResults([]);
      return;
    }

    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          headers: { 'x-team-member-id': user.team_member_id },
        });
        if (!res.ok) {
          if (!cancelled) setResults([]);
          return;
        }
        const data = await res.json();
        if (!cancelled) setResults(Array.isArray(data.leads) ? data.leads : []);
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, user]);

  if (results.length === 0) return null;

  return (
    <CommandGroup heading="Leads">
      {results.map((lead) => {
        const name = lead.contact_name || 'Unknown contact';
        const company = lead.company_name || '';
        return (
          <CommandItem
            key={lead.id}
            value={`lead ${lead.id} ${name} ${company}`}
            onSelect={() => {
              router.push(`/leads/${lead.id}`);
              onSelect();
            }}
          >
            <User />
            <span className="truncate">{name}</span>
            {company && (
              <span className="ml-2 truncate text-xs text-muted-foreground">
                {company}
              </span>
            )}
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}
