'use client';

import { useRouter } from 'next/navigation';
import {
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import {
  Send,
  LayoutDashboard,
  BarChart3,
  Settings,
  Mail,
  Plus,
  LogOut,
} from '@/lib/icons';
import { useSession } from '@/hooks/use-session';
import type { CommandContext } from '../hooks/use-command-context';

type Props = {
  context: CommandContext;
  onSelect: () => void;
};

export function ActionsGroup({ context, onSelect }: Props) {
  const router = useRouter();
  const { setUser } = useSession();

  const go = (path: string) => {
    router.push(path);
    onSelect();
  };

  return (
    <CommandGroup heading="Actions">
      {context.currentLeadId && (
        <CommandItem
          value={`compose-email-current-lead ${context.currentLeadId}`}
          onSelect={() => go(`/leads/${context.currentLeadId}?compose=1`)}
        >
          <Send />
          <span>Compose email to current lead</span>
        </CommandItem>
      )}
      <CommandItem value="goto-inbox" onSelect={() => go('/inbox')}>
        <Mail />
        <span>Go to Inbox</span>
      </CommandItem>
      <CommandItem value="goto-dashboard" onSelect={() => go('/')}>
        <LayoutDashboard />
        <span>Go to Dashboard</span>
      </CommandItem>
      <CommandItem value="goto-analytics" onSelect={() => go('/analytics')}>
        <BarChart3 />
        <span>Go to Analytics</span>
      </CommandItem>
      <CommandItem value="goto-settings" onSelect={() => go('/settings')}>
        <Settings />
        <span>Go to Settings</span>
      </CommandItem>
      <CommandItem value="add-lead" onSelect={() => go('/leads?new=true')}>
        <Plus />
        <span>Add lead</span>
      </CommandItem>
      <CommandItem
        value="log-out"
        onSelect={() => {
          setUser(null);
          onSelect();
        }}
      >
        <LogOut />
        <span>Log out</span>
      </CommandItem>
    </CommandGroup>
  );
}
