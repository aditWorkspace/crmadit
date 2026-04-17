'use client';

import { Suspense } from 'react';
import { InboxPane } from '@/components/inbox/inbox-pane';
import { SnoozePopover } from '@/components/inbox/snooze-popover';
import { PresenceStrip } from '@/components/inbox/presence-strip';

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPane />
      {/* Lane F singletons: global listeners, portal into ThreadReader header. */}
      <SnoozePopover />
      <PresenceStrip />
    </Suspense>
  );
}
