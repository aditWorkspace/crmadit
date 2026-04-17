'use client';

import { useRouter } from 'next/navigation';
import {
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import {
  LayoutDashboard,
  CalendarDays,
  Send,
  Clock,
  BarChart3,
  BookOpen,
  Mail,
  Settings,
} from '@/lib/icons';

type Props = { onSelect: () => void };

// Items already covered in Actions group (keeps things DRY-ish)
const ACTION_HREFS = new Set(['/', '/inbox', '/analytics', '/settings']);

const NAV_ITEMS: Array<{
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { href: '/', label: 'Pipeline', icon: LayoutDashboard },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/mass-email', label: 'Outreach', icon: Send },
  { href: '/follow-ups', label: 'Follow-ups', icon: Clock },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/insights', label: 'Insights', icon: BookOpen },
  { href: '/inbox', label: 'Inbox', icon: Mail },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function NavigationGroup({ onSelect }: Props) {
  const router = useRouter();
  const items = NAV_ITEMS.filter((item) => !ACTION_HREFS.has(item.href));

  if (items.length === 0) return null;

  return (
    <CommandGroup heading="Navigation">
      {items.map(({ href, label, icon: Icon }) => (
        <CommandItem
          key={href}
          value={`nav ${href} ${label}`}
          onSelect={() => {
            router.push(href);
            onSelect();
          }}
        >
          <Icon />
          <span>{label}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
