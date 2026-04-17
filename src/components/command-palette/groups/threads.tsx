'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { Mail } from '@/lib/icons';
import { useSession } from '@/hooks/use-session';

type ThreadHit = {
  gmail_thread_id: string;
  latest_subject: string | null;
  contact_name: string | null;
  company_name: string | null;
};

type Props = {
  query: string;
  onSelect: () => void;
};

export function ThreadsGroup({ query, onSelect }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const [results, setResults] = useState<ThreadHit[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !user) {
      setResults([]);
      return;
    }

    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(q)}&include=threads`,
          { headers: { 'x-team-member-id': user.team_member_id } }
        );
        if (!res.ok) {
          if (!cancelled) setResults([]);
          return;
        }
        const data = await res.json();
        if (!cancelled) setResults(Array.isArray(data.threads) ? data.threads : []);
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, user]);

  if (results.length === 0) return null;

  return (
    <CommandGroup heading="Threads">
      {results.map((t) => {
        const subject = t.latest_subject || '(no subject)';
        const who = t.contact_name || t.company_name || '';
        return (
          <CommandItem
            key={t.gmail_thread_id}
            value={`thread ${t.gmail_thread_id} ${subject} ${who}`}
            onSelect={() => {
              router.push(`/inbox?thread=${t.gmail_thread_id}`);
              onSelect();
            }}
          >
            <Mail />
            <span className="truncate">{subject}</span>
            {who && (
              <span className="ml-2 truncate text-xs text-muted-foreground">
                {who}
              </span>
            )}
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}
