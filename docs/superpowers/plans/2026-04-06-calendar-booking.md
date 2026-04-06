# Calendar + Nav Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared-availability internal calendar view, a public cal.com-style booking page, a List/Board toggle on the Pipeline page, and resizable panels throughout.

**Architecture:** Google Calendar freebusy API (same OAuth tokens already in DB) powers both the internal heatmap and the public booking page. A single `/api/calendar/availability` endpoint aggregates all 3 founders' busy slots; `/api/calendar/book` is public and creates events on all calendars. ResizeHandle is a drag component placed between panels. Pipeline view gets a view-mode toggle that swaps in the existing KanbanBoard.

**Tech Stack:** Next.js 16.2 App Router, googleapis (already installed), date-fns v4, dnd-kit (already installed), Tailwind v4, Supabase admin client.

---

## File Map

### New
```
src/lib/google/calendar.ts                          — add getFreeBusy() (modify existing)
src/app/api/calendar/availability/route.ts          — GET freebusy aggregation (no auth)
src/app/api/calendar/book/route.ts                  — POST booking (public, no auth)
src/components/ui/resize-handle.tsx                 — draggable panel divider
src/components/calendar/availability-grid.tsx       — internal heatmap grid
src/app/calendar/page.tsx                           — internal calendar page
src/components/calendar/time-slot-list.tsx          — time slot buttons for /book
src/components/calendar/booking-form.tsx            — name/email/note form for /book
src/app/book/page.tsx                               — public booking page (no auth)
src/app/book/confirmation/page.tsx                  — post-booking confirmation
```

### Modified
```
src/components/pipeline/pipeline-view.tsx           — add List/Board toggle
src/app/pipeline/page.tsx                           — redirect to /
src/components/layout/sidebar.tsx                   — add Calendar nav item
```

---

## Task 1: Add `getFreeBusy()` to calendar lib

**Files:**
- Modify: `src/lib/google/calendar.ts`

- [ ] **Step 1: Add FreeBusyResult type and getFreeBusy function**

Append to the end of `src/lib/google/calendar.ts`:

```typescript
export interface FreeBusyResult {
  memberId: string;
  busy: { start: string; end: string }[];
}

/**
 * Query Google Calendar freebusy API for a single member.
 * Returns busy blocks in the given time range.
 */
export async function getFreeBusy(
  teamMemberId: string,
  timeMin: Date,
  timeMax: Date
): Promise<FreeBusyResult> {
  const calendar = await getCalendarClientForMember(teamMemberId);

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: 'primary' }],
    },
  });

  const busy = res.data.calendars?.['primary']?.busy ?? [];

  return {
    memberId: teamMemberId,
    busy: busy
      .map(b => ({ start: b.start ?? '', end: b.end ?? '' }))
      .filter(b => b.start && b.end),
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/google/calendar.ts
git commit -m "feat: add getFreeBusy() to calendar lib"
```

---

## Task 2: Availability API route

**Files:**
- Create: `src/app/api/calendar/availability/route.ts`

- [ ] **Step 1: Create the route**

```typescript
// src/app/api/calendar/availability/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreeBusy } from '@/lib/google/calendar';

function overlaps(
  slotStart: Date,
  slotEnd: Date,
  busy: { start: string; end: string }[]
): boolean {
  return busy.some(b => new Date(b.start) < slotEnd && new Date(b.end) > slotStart);
}

export async function GET(req: NextRequest) {
  const start = req.nextUrl.searchParams.get('start');
  const end = req.nextUrl.searchParams.get('end');
  if (!start || !end) {
    return NextResponse.json({ error: 'Missing start or end param' }, { status: 400 });
  }

  const timeMin = new Date(start);
  const timeMax = new Date(end);
  if (isNaN(timeMin.getTime()) || isNaN(timeMax.getTime())) {
    return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: members } = await supabase
    .from('team_members')
    .select('id, name')
    .eq('gmail_connected', true);

  if (!members?.length) {
    return NextResponse.json({ slots: [], connectedCount: 0, timezone: 'America/Los_Angeles' });
  }

  // Fetch freebusy for all members in parallel; skip failures gracefully
  const results = await Promise.allSettled(
    members.map(m => getFreeBusy(m.id, timeMin, timeMax))
  );

  const busyByMember: Record<string, { start: string; end: string }[]> = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      busyByMember[members[i].id] = r.value.busy;
    }
  });

  // Build 30-min slots across the full range
  const slots: { start: string; end: string; busyCount: number }[] = [];
  const cursor = new Date(timeMin);
  while (cursor < timeMax) {
    const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
    const busyCount = members.filter(
      m => busyByMember[m.id] && overlaps(cursor, slotEnd, busyByMember[m.id])
    ).length;
    slots.push({
      start: cursor.toISOString(),
      end: slotEnd.toISOString(),
      busyCount,
    });
    cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
  }

  return NextResponse.json({ slots, connectedCount: members.length, timezone: 'America/Los_Angeles' });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/calendar/availability/route.ts
git commit -m "feat: add GET /api/calendar/availability endpoint"
```

---

## Task 3: Booking API route

**Files:**
- Create: `src/app/api/calendar/book/route.ts`

- [ ] **Step 1: Create the route**

```typescript
// src/app/api/calendar/book/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreeBusy, createMeetingEvent } from '@/lib/google/calendar';

function overlaps(
  slotStart: Date,
  slotEnd: Date,
  busy: { start: string; end: string }[]
): boolean {
  return busy.some(b => new Date(b.start) < slotEnd && new Date(b.end) > slotStart);
}

export async function POST(req: NextRequest) {
  let body: {
    name: string;
    email: string;
    startTime: string;
    durationMinutes: number;
    note?: string;
    timezone?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, email, startTime, durationMinutes, note } = body;

  if (!name?.trim() || !email?.trim() || !startTime || ![15, 30].includes(durationMinutes)) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
  }

  const start = new Date(startTime);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  if (isNaN(start.getTime())) {
    return NextResponse.json({ error: 'Invalid startTime' }, { status: 400 });
  }

  // Must be at least 2 hours from now
  if (start.getTime() < Date.now() + 2 * 60 * 60 * 1000) {
    return NextResponse.json({ error: 'Please book at least 2 hours in advance' }, { status: 400 });
  }

  // Must be within 9am–5pm PT on a weekday
  const ptHour = parseInt(
    new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })
  );
  const ptDay = new Date(start).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
  if (['Sat', 'Sun'].includes(ptDay) || ptHour < 9 || ptHour >= 17) {
    return NextResponse.json({ error: 'Slot is outside booking hours (Mon–Fri, 9am–5pm PT)' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: members } = await supabase
    .from('team_members')
    .select('id, name, email')
    .eq('gmail_connected', true);

  if (!members?.length) {
    return NextResponse.json({ error: 'No team members available' }, { status: 503 });
  }

  // Re-validate: check that ≥2 members are still free
  const results = await Promise.allSettled(
    members.map(m => getFreeBusy(m.id, start, end))
  );

  const freeMembers = members.filter((_, i) => {
    const r = results[i];
    return r.status === 'fulfilled' && !overlaps(start, end, r.value.busy);
  });

  if (freeMembers.length < 2) {
    return NextResponse.json(
      { error: 'Slot no longer available — please pick another time' },
      { status: 409 }
    );
  }

  // Create the event on the first free member's calendar.
  // All founders + prospect are added as attendees — Google sends invites automatically.
  const allEmails = [...members.map(m => m.email), email];

  const event = await createMeetingEvent(freeMembers[0].id, {
    summary: `Quick call — ${name.trim()} × Proxi AI`,
    description: note?.trim()
      ? `Booking note: ${note.trim()}\n\nsource:proxi_crm`
      : 'source:proxi_crm',
    startTime: start,
    endTime: end,
    attendeeEmails: allEmails,
  });

  return NextResponse.json({
    meetLink: event.meetLink,
    eventLink: event.eventLink,
    startTime: event.startTime,
    endTime: end.toISOString(),
    name: name.trim(),
    durationMinutes,
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/calendar/book/route.ts
git commit -m "feat: add POST /api/calendar/book endpoint"
```

---

## Task 4: ResizeHandle component

**Files:**
- Create: `src/components/ui/resize-handle.tsx`

- [ ] **Step 1: Create the component**

```typescript
// src/components/ui/resize-handle.tsx
'use client';

import { useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';

interface ResizeHandleProps {
  /** localStorage key to persist the resized width */
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** Called with the new width on every drag move */
  onResize: (width: number) => void;
  className?: string;
}

export function ResizeHandle({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  onResize,
  className,
}: ResizeHandleProps) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(defaultWidth);

  // Restore persisted width on mount
  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const w = parseInt(stored, 10);
      if (!isNaN(w) && w >= minWidth && w <= maxWidth) onResize(w);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = parseInt(localStorage.getItem(storageKey) ?? String(defaultWidth), 10);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [storageKey, defaultWidth]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta));
      onResize(newWidth);
      localStorage.setItem(storageKey, String(Math.round(newWidth)));
    };
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [minWidth, maxWidth, onResize]);

  return (
    <div
      onMouseDown={onMouseDown}
      className={cn(
        'w-1 flex-shrink-0 cursor-col-resize bg-gray-100 hover:bg-blue-400 active:bg-blue-500 transition-colors',
        className
      )}
    />
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/resize-handle.tsx
git commit -m "feat: add ResizeHandle draggable panel divider component"
```

---

## Task 5: Pipeline List/Board toggle + resizable lead list

**Files:**
- Modify: `src/components/pipeline/pipeline-view.tsx`

- [ ] **Step 1: Rewrite pipeline-view.tsx with view toggle and ResizeHandle**

Replace the entire file contents:

```typescript
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { LeadList, PipelineLead } from './lead-list';
import { LeadPanel } from './lead-panel';
import { KanbanBoard } from './kanban-board';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { Loader2, LayoutList, Kanban } from 'lucide-react';
import { cn } from '@/lib/utils';

type FilterTab = 'all' | 'mine' | 'calls' | 'demos' | 'weekly';
type ViewMode = 'list' | 'board';

function EmptyPanel() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-12 bg-gray-50/30">
      <LayoutList className="h-10 w-10 text-gray-200 mb-4" />
      <p className="text-sm font-medium text-gray-400">Select a lead to view the conversation</p>
      <p className="text-xs text-gray-300 mt-1">Or use the filter tabs to find what needs attention</p>
    </div>
  );
}

export function PipelineView() {
  const { user } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [leads, setLeads] = useState<PipelineLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('id'));
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [listWidth, setListWidth] = useState(320);

  // Restore persisted view mode on mount
  useEffect(() => {
    const stored = localStorage.getItem('proxi-pipeline-view') as ViewMode | null;
    if (stored === 'board') setViewMode('board');
  }, []);

  const toggleView = () => {
    const next: ViewMode = viewMode === 'list' ? 'board' : 'list';
    setViewMode(next);
    localStorage.setItem('proxi-pipeline-view', next);
  };

  const fetchLeads = useCallback(async () => {
    if (!user) return;
    const res = await fetch(`/api/pipeline?filter=${filter}`, {
      headers: { 'x-team-member-id': user.team_member_id },
    });
    if (res.ok) {
      const data = await res.json();
      setLeads(data.leads || []);
    }
    setLoading(false);
  }, [user, filter]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    router.replace(`/?id=${id}`, { scroll: false });
  };

  const handleClose = () => {
    setSelectedId(null);
    router.replace('/', { scroll: false });
  };

  const handleDelete = (id: string) => {
    setLeads(prev => prev.filter(l => l.id !== id));
    setSelectedId(null);
    router.replace('/', { scroll: false });
  };

  const handleFilterChange = (f: FilterTab) => {
    setFilter(f);
    setLoading(true);
  };

  if (loading && leads.length === 0 && viewMode === 'list') {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* View toggle bar */}
      <div className="flex-shrink-0 flex items-center gap-1 px-3 pt-2 pb-0">
        <button
          onClick={toggleView}
          className={cn(
            'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors',
            viewMode === 'list'
              ? 'bg-gray-900 text-white'
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
          )}
        >
          <LayoutList className="h-3.5 w-3.5" />
          List
        </button>
        <button
          onClick={toggleView}
          className={cn(
            'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors',
            viewMode === 'board'
              ? 'bg-gray-900 text-white'
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
          )}
        >
          <Kanban className="h-3.5 w-3.5" />
          Board
        </button>
      </div>

      {viewMode === 'board' ? (
        <div className="flex-1 overflow-auto px-4 py-3">
          <KanbanBoard />
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel — resizable lead list */}
          <div style={{ width: listWidth }} className="flex-shrink-0">
            <LeadList
              leads={leads}
              selectedId={selectedId}
              filter={filter}
              onFilterChange={handleFilterChange}
              onSelect={handleSelect}
            />
          </div>

          <ResizeHandle
            storageKey="proxi-leadlist-width"
            defaultWidth={320}
            minWidth={240}
            maxWidth={480}
            onResize={setListWidth}
          />

          {/* Right panel */}
          {selectedId ? (
            <LeadPanel
              key={selectedId}
              leadId={selectedId}
              onClose={handleClose}
              onDelete={handleDelete}
            />
          ) : (
            <EmptyPanel />
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/pipeline/pipeline-view.tsx
git commit -m "feat: add List/Board toggle and resizable lead list to pipeline"
```

---

## Task 6: Sidebar nav + retire /pipeline page

**Files:**
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `src/app/pipeline/page.tsx`

- [ ] **Step 1: Add Calendar nav item to sidebar**

In `src/components/layout/sidebar.tsx`, change:

```typescript
import {
  LayoutDashboard, BarChart3, Settings,
  LogOut, Menu, X, Moon, Sun,
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', label: 'Pipeline', icon: LayoutDashboard },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];
```

To:

```typescript
import {
  LayoutDashboard, BarChart3, Settings,
  LogOut, Menu, X, Moon, Sun, CalendarDays,
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', label: 'Pipeline', icon: LayoutDashboard },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];
```

- [ ] **Step 2: Redirect /pipeline to /**

Replace contents of `src/app/pipeline/page.tsx`:

```typescript
import { redirect } from 'next/navigation';

export default function PipelinePage() {
  redirect('/');
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/sidebar.tsx src/app/pipeline/page.tsx
git commit -m "feat: add Calendar nav item, redirect /pipeline to /"
```

---

## Task 7: Internal Calendar page + AvailabilityGrid

**Files:**
- Create: `src/components/calendar/availability-grid.tsx`
- Create: `src/app/calendar/page.tsx`

- [ ] **Step 1: Create AvailabilityGrid component**

```typescript
// src/components/calendar/availability-grid.tsx
'use client';

import { useMemo } from 'react';
import { format, addDays, startOfDay } from 'date-fns';
import { cn } from '@/lib/utils';

interface Slot {
  start: string;
  end: string;
  busyCount: number;
}

interface AvailabilityGridProps {
  slots: Slot[];
  weekStart: Date;
  connectedCount: number;
}

// PT hours to display: 8am–8pm = 24 half-hour rows
const START_HOUR = 8;
const END_HOUR = 20;

function getPTHour(iso: string): number {
  return parseInt(
    new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      hour12: false,
    })
  );
}

function getPTMinute(iso: string): number {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    minute: '2-digit',
  }) === '00' ? 0 : 30;
}

function getDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // YYYY-MM-DD
}

const BUSY_COLORS: Record<number, string> = {
  0: 'bg-white hover:bg-blue-50 cursor-pointer',
  1: 'bg-gray-100',
  2: 'bg-gray-400',
  3: 'bg-gray-800',
};

export function AvailabilityGrid({ slots, weekStart, connectedCount }: AvailabilityGridProps) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // Build lookup: "YYYY-MM-DD:HH:mm" → busyCount
  const slotMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of slots) {
      const h = getPTHour(s.start);
      const m = getPTMinute(s.start);
      if (h >= START_HOUR && h < END_HOUR) {
        const key = `${getDateKey(s.start)}:${String(h).padStart(2, '0')}:${m === 0 ? '00' : '30'}`;
        map[key] = s.busyCount;
      }
    }
    return map;
  }, [slots]);

  const timeRows = useMemo(() => {
    const rows: { label: string; hour: number; minute: number }[] = [];
    for (let h = START_HOUR; h < END_HOUR; h++) {
      rows.push({ label: format(new Date(2020, 0, 1, h, 0), 'h:mm a'), hour: h, minute: 0 });
      rows.push({ label: '', hour: h, minute: 30 });
    }
    return rows;
  }, []);

  return (
    <div className="overflow-auto">
      <div className="min-w-[600px]">
        {/* Header row */}
        <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-gray-100">
          <div />
          {days.map(d => (
            <div key={d.toISOString()} className="text-center py-2">
              <div className="text-xs font-medium text-gray-500">{format(d, 'EEE')}</div>
              <div className="text-sm font-semibold text-gray-900">{format(d, 'd')}</div>
            </div>
          ))}
        </div>

        {/* Time rows */}
        {timeRows.map(row => (
          <div key={`${row.hour}:${row.minute}`} className="grid grid-cols-[60px_repeat(7,1fr)]">
            <div className="text-right pr-2 text-xs text-gray-400 leading-none pt-1">
              {row.label}
            </div>
            {days.map(d => {
              const dateKey = format(d, 'yyyy-MM-dd');
              const key = `${dateKey}:${String(row.hour).padStart(2, '0')}:${row.minute === 0 ? '00' : '30'}`;
              const busyCount = slotMap[key] ?? 0;
              return (
                <div
                  key={key}
                  className={cn(
                    'h-5 border-b border-r border-gray-50 transition-colors',
                    BUSY_COLORS[Math.min(busyCount, connectedCount)] ?? 'bg-gray-800'
                  )}
                  title={busyCount === 0 ? 'All free' : `${busyCount} busy`}
                />
              );
            })}
          </div>
        ))}

        {/* Legend */}
        <div className="flex items-center gap-4 pt-4 px-2 text-xs text-gray-500">
          <span className="font-medium">Busy founders:</span>
          {[
            { count: 0, label: 'None', cls: 'bg-white border border-gray-200' },
            { count: 1, label: '1', cls: 'bg-gray-100' },
            { count: 2, label: '2', cls: 'bg-gray-400' },
            { count: 3, label: '3', cls: 'bg-gray-800' },
          ].map(({ count, label, cls }) => (
            <div key={count} className="flex items-center gap-1">
              <div className={cn('h-3 w-5 rounded-sm', cls)} />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the Calendar page**

```typescript
// src/app/calendar/page.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { startOfWeek, addWeeks, addDays, endOfDay } from 'date-fns';
import { format } from 'date-fns';
import { useSession } from '@/hooks/use-session';
import { AvailabilityGrid } from '@/components/calendar/availability-grid';
import { ChevronLeft, ChevronRight, RefreshCw, Loader2, ExternalLink } from 'lucide-react';

interface Slot {
  start: string;
  end: string;
  busyCount: number;
}

export default function CalendarPage() {
  const { user } = useSession();
  const [weekStart, setWeekStart] = useState<Date>(() =>
    startOfWeek(new Date(), { weekStartsOn: 1 }) // Monday
  );
  const [slots, setSlots] = useState<Slot[]>([]);
  const [connectedCount, setConnectedCount] = useState(3);
  const [loading, setLoading] = useState(true);

  const fetchAvailability = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const start = weekStart;
    const end = endOfDay(addDays(weekStart, 6));
    try {
      const res = await fetch(
        `/api/calendar/availability?start=${start.toISOString()}&end=${end.toISOString()}`,
        { headers: { 'x-team-member-id': user.team_member_id } }
      );
      const data = await res.json();
      setSlots(data.slots ?? []);
      setConnectedCount(data.connectedCount ?? 3);
    } catch {
      // keep stale data
    } finally {
      setLoading(false);
    }
  }, [user, weekStart]);

  useEffect(() => { fetchAvailability(); }, [fetchAvailability]);

  const prevWeek = () => setWeekStart(w => addWeeks(w, -1));
  const nextWeek = () => setWeekStart(w => addWeeks(w, 1));

  return (
    <div className="flex flex-col h-full p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Calendar</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Shared availability across all connected founders
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/book"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Public booking page
          </a>
          <button
            onClick={fetchAvailability}
            disabled={loading}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-40 transition-colors p-1"
            title="Refresh"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Week navigation */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={prevWeek} className="p-1 rounded hover:bg-gray-100 text-gray-600 transition-colors">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="text-sm font-medium text-gray-700 min-w-[160px] text-center">
          {format(weekStart, 'MMM d')} – {format(addDays(weekStart, 6), 'MMM d, yyyy')}
        </span>
        <button onClick={nextWeek} className="p-1 rounded hover:bg-gray-100 text-gray-600 transition-colors">
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto rounded-xl border border-gray-200 bg-white p-4">
        {loading && slots.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
          </div>
        ) : (
          <AvailabilityGrid slots={slots} weekStart={weekStart} connectedCount={connectedCount} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/calendar/availability-grid.tsx src/app/calendar/page.tsx
git commit -m "feat: add internal calendar page with availability heatmap"
```

---

## Task 8: Public booking page components

**Files:**
- Create: `src/components/calendar/time-slot-list.tsx`
- Create: `src/components/calendar/booking-form.tsx`

- [ ] **Step 1: Create TimeSlotList**

```typescript
// src/components/calendar/time-slot-list.tsx
'use client';

import { cn } from '@/lib/utils';
import { format } from 'date-fns';

interface Slot {
  start: string;
  end: string;
  busyCount: number;
}

interface TimeSlotListProps {
  slots: Slot[];           // already filtered to selected date + business hours
  selectedSlot: string | null;
  durationMinutes: 15 | 30;
  onSelect: (start: string) => void;
}

export function TimeSlotList({ slots, selectedSlot, durationMinutes, onSelect }: TimeSlotListProps) {
  const bookableSlots = slots.filter(s => s.busyCount <= 1); // ≥2 of 3 are free

  if (bookableSlots.length === 0) {
    return (
      <p className="text-sm text-gray-500 px-2 py-4">No available times on this day.</p>
    );
  }

  // For 15m duration, show all 30-min anchor slots (Google Calendar creates 15m blocks within them)
  // For 30m, show all bookable 30-min slots
  const displaySlots = durationMinutes === 15
    ? bookableSlots
    : bookableSlots;

  return (
    <div className="space-y-2 overflow-y-auto max-h-[480px] pr-1">
      {displaySlots.map(slot => {
        const selected = selectedSlot === slot.start;
        return (
          <button
            key={slot.start}
            onClick={() => onSelect(slot.start)}
            className={cn(
              'w-full flex items-center gap-2.5 px-4 py-3 rounded-lg border text-sm font-medium transition-colors',
              selected
                ? 'border-white bg-white text-gray-900'
                : 'border-gray-700 text-gray-200 hover:border-gray-400 hover:text-white'
            )}
          >
            <span className={cn('h-2 w-2 rounded-full flex-shrink-0', selected ? 'bg-green-500' : 'bg-green-400')} />
            {format(new Date(slot.start), 'h:mm a')}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create BookingForm**

```typescript
// src/components/calendar/booking-form.tsx
'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Loader2, ArrowLeft } from 'lucide-react';

interface BookingFormProps {
  startTime: string;
  durationMinutes: 15 | 30;
  onBack: () => void;
  onConfirm: (data: { name: string; email: string; note: string }) => Promise<void>;
}

export function BookingForm({ startTime, durationMinutes, onBack, onConfirm }: BookingFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm({ name: name.trim(), email: email.trim(), note: note.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="border border-gray-700 rounded-lg px-4 py-3 text-sm text-gray-300">
        <div className="font-medium text-white">
          {format(new Date(startTime), 'EEEE, MMMM d · h:mm a')}
        </div>
        <div className="text-gray-400 mt-0.5">{durationMinutes} min · Google Meet</div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">Your name *</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Jane Smith"
            required
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">Email address *</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="jane@company.com"
            required
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">Additional notes</label>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Anything you'd like us to know beforehand?"
            rows={3}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 transition-colors resize-none"
          />
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim() || !email.trim()}
            className="flex-1 flex items-center justify-center gap-2 bg-white text-gray-900 rounded-lg py-2.5 text-sm font-semibold hover:bg-gray-100 disabled:opacity-40 transition-colors"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirm booking
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/calendar/time-slot-list.tsx src/components/calendar/booking-form.tsx
git commit -m "feat: add TimeSlotList and BookingForm components for /book"
```

---

## Task 9: Public booking page + confirmation

**Files:**
- Create: `src/app/book/page.tsx`
- Create: `src/app/book/confirmation/page.tsx`

- [ ] **Step 1: Create /book/confirmation page**

```typescript
// src/app/book/confirmation/page.tsx
'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { format } from 'date-fns';
import { CheckCircle, Video, Calendar } from 'lucide-react';

function ConfirmationContent() {
  const params = useSearchParams();
  const meetLink = params.get('meetLink');
  const startTime = params.get('startTime');
  const endTime = params.get('endTime');
  const name = params.get('name');
  const durationMinutes = params.get('durationMinutes');

  const start = startTime ? new Date(startTime) : null;

  return (
    <div className="min-h-screen bg-[#111] flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-green-500/10 border border-green-500/20 mb-4">
            <CheckCircle className="h-8 w-8 text-green-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">You're confirmed!</h1>
          <p className="text-gray-400 mt-2">
            A calendar invite has been sent to your email.
          </p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4 mb-6">
          {name && (
            <div className="text-sm text-gray-300">
              <span className="text-gray-500">Name: </span>{name}
            </div>
          )}
          {start && (
            <div className="text-sm text-gray-300">
              <span className="text-gray-500">When: </span>
              {format(start, 'EEEE, MMMM d, yyyy')} at {format(start, 'h:mm a')} PT
            </div>
          )}
          {durationMinutes && (
            <div className="text-sm text-gray-300">
              <span className="text-gray-500">Duration: </span>{durationMinutes} minutes
            </div>
          )}
        </div>

        <div className="space-y-3">
          {meetLink && (
            <a
              href={meetLink}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full bg-white text-gray-900 rounded-xl py-3 font-semibold text-sm hover:bg-gray-100 transition-colors"
            >
              <Video className="h-4 w-4" />
              Join Google Meet
            </a>
          )}
          <a
            href="/book"
            className="flex items-center justify-center gap-2 w-full border border-gray-700 text-gray-300 rounded-xl py-3 text-sm hover:border-gray-500 transition-colors"
          >
            <Calendar className="h-4 w-4" />
            Book another time
          </a>
        </div>
      </div>
    </div>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense>
      <ConfirmationContent />
    </Suspense>
  );
}
```

- [ ] **Step 2: Create /book page**

```typescript
// src/app/book/page.tsx
'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  startOfMonth, endOfMonth, addMonths, subMonths,
  startOfWeek, addDays, isSameMonth, isToday, format, isSameDay, parseISO
} from 'date-fns';
import { ChevronLeft, ChevronRight, Video, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TimeSlotList } from '@/components/calendar/time-slot-list';
import { BookingForm } from '@/components/calendar/booking-form';

interface Slot {
  start: string;
  end: string;
  busyCount: number;
}

type Step = 'calendar' | 'slots' | 'form';

const DURATION_OPTIONS: { value: 15 | 30; label: string }[] = [
  { value: 15, label: '15m' },
  { value: 30, label: '30m' },
];

function getPTHour(iso: string): number {
  return parseInt(
    new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      hour12: false,
    })
  );
}

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

export default function BookPage() {
  const router = useRouter();
  const [month, setMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [duration, setDuration] = useState<15 | 30>(30);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [step, setStep] = useState<Step>('calendar');
  const [loadingSlots, setLoadingSlots] = useState(false);

  // Fetch availability for the visible month + next month
  const fetchSlots = useCallback(async () => {
    setLoadingSlots(true);
    try {
      const start = startOfMonth(month);
      const end = endOfMonth(addMonths(month, 1));
      const res = await fetch(
        `/api/calendar/availability?start=${start.toISOString()}&end=${end.toISOString()}`
      );
      const data = await res.json();
      setSlots(data.slots ?? []);
    } catch {
      // keep stale
    } finally {
      setLoadingSlots(false);
    }
  }, [month]);

  useEffect(() => { fetchSlots(); }, [fetchSlots]);

  // Days with ≥1 bookable slot (9am–5pm PT weekdays, ≤1 busy)
  const daysWithSlots = useMemo(() => {
    const days = new Set<string>();
    for (const s of slots) {
      if (s.busyCount > 1) continue;
      const h = getPTHour(s.start);
      if (h < 9 || h >= 17) continue;
      const date = new Date(s.start).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const d = parseISO(date);
      if (isWeekday(d)) days.add(date);
    }
    return days;
  }, [slots]);

  // Slots for selected date, 9am–5pm PT
  const slotsForDay = useMemo(() => {
    if (!selectedDate) return [];
    const dateKey = format(selectedDate, 'yyyy-MM-dd');
    return slots.filter(s => {
      const h = getPTHour(s.start);
      const slotDateKey = new Date(s.start).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      return slotDateKey === dateKey && h >= 9 && h < 17;
    });
  }, [slots, selectedDate]);

  // Build calendar grid
  const calendarDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) days.push(addDays(start, i));
    return days;
  }, [month]);

  const handleDateSelect = (d: Date) => {
    const key = format(d, 'yyyy-MM-dd');
    if (!daysWithSlots.has(key)) return;
    setSelectedDate(d);
    setSelectedSlot(null);
    setStep('slots');
  };

  const handleSlotSelect = (start: string) => {
    setSelectedSlot(start);
    setStep('form');
  };

  const handleBook = async (data: { name: string; email: string; note: string }) => {
    if (!selectedSlot) return;
    const res = await fetch('/api/calendar/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        startTime: selectedSlot,
        durationMinutes: duration,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Booking failed');

    // Navigate to confirmation with booking details in query params
    const params = new URLSearchParams({
      meetLink: result.meetLink ?? '',
      startTime: result.startTime,
      endTime: result.endTime,
      name: data.name,
      durationMinutes: String(duration),
    });
    router.push(`/book/confirmation?${params.toString()}`);
  };

  return (
    <div className="min-h-screen bg-[#111] flex items-center justify-center p-4 md:p-8">
      <div className="w-full max-w-[900px] bg-[#1c1c1c] border border-gray-800 rounded-2xl overflow-hidden flex flex-col md:flex-row">

        {/* Left panel — team info */}
        <div className="p-6 md:p-8 md:w-[260px] md:border-r border-gray-800 flex-shrink-0">
          <div className="h-10 w-10 rounded-full bg-gray-700 flex items-center justify-center text-white font-semibold text-sm mb-4">
            P
          </div>
          <p className="text-gray-400 text-xs font-medium mb-1">Proxi AI</p>
          <h1 className="text-xl font-bold text-white mb-2">Quick call</h1>
          <p className="text-gray-400 text-sm mb-6">Chat with the Proxi team about your product workflows.</p>

          {/* Duration selector */}
          <div className="flex items-center gap-1.5 mb-5">
            <span className="text-gray-500 text-xs mr-1">⏱</span>
            {DURATION_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setDuration(opt.value)}
                className={cn(
                  'px-3 py-1 rounded-md text-sm font-medium transition-colors',
                  duration === opt.value
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-gray-500 text-xs mb-2">
            <Video className="h-3.5 w-3.5" />
            Google Meet
          </div>
          <div className="flex items-center gap-2 text-gray-500 text-xs">
            <Globe className="h-3.5 w-3.5" />
            America/Los_Angeles
          </div>
        </div>

        {/* Center — calendar */}
        <div className="p-6 md:p-8 flex-1 md:border-r border-gray-800">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-white font-semibold">
              {format(month, 'MMMM')}{' '}
              <span className="text-gray-500 font-normal">{format(month, 'yyyy')}</span>
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setMonth(m => subMonths(m, 1))}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => setMonth(m => addMonths(m, 1))}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 mb-2">
            {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map(d => (
              <div key={d} className="text-center text-xs font-medium text-gray-500 py-1">{d}</div>
            ))}
          </div>

          {/* Calendar days */}
          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((d, i) => {
              const key = format(d, 'yyyy-MM-dd');
              const inMonth = isSameMonth(d, month);
              const available = daysWithSlots.has(key);
              const selected = selectedDate ? isSameDay(d, selectedDate) : false;
              const today = isToday(d);

              return (
                <button
                  key={i}
                  onClick={() => handleDateSelect(d)}
                  disabled={!available || !inMonth}
                  className={cn(
                    'aspect-square flex items-center justify-center rounded-lg text-sm transition-colors relative',
                    !inMonth && 'opacity-0 pointer-events-none',
                    inMonth && !available && 'text-gray-600 cursor-default',
                    inMonth && available && !selected && 'bg-gray-800 text-white hover:bg-gray-700 cursor-pointer',
                    selected && 'bg-white text-gray-900 font-semibold',
                    today && !selected && 'ring-1 ring-gray-500'
                  )}
                >
                  {format(d, 'd')}
                  {today && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-0.5 w-0.5 rounded-full bg-current" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right panel — slots or form */}
        {(step === 'slots' || step === 'form') && selectedDate && (
          <div className="p-6 md:p-8 md:w-[260px] flex-shrink-0">
            <h3 className="text-white font-semibold mb-1">
              {format(selectedDate, 'EEE')} <span className="font-bold">{format(selectedDate, 'd')}</span>
            </h3>
            <div className="flex items-center gap-2 mb-5">
              <button onClick={() => setStep('calendar')} className="text-xs text-gray-400 hover:text-gray-200">← Back</button>
            </div>

            {step === 'slots' && (
              <TimeSlotList
                slots={slotsForDay}
                selectedSlot={selectedSlot}
                durationMinutes={duration}
                onSelect={handleSlotSelect}
              />
            )}

            {step === 'form' && selectedSlot && (
              <BookingForm
                startTime={selectedSlot}
                durationMinutes={duration}
                onBack={() => setStep('slots')}
                onConfirm={handleBook}
              />
            )}
          </div>
        )}
      </div>

      {/* Cal.com credit style footer */}
      <div className="fixed bottom-4 left-0 right-0 text-center text-xs text-gray-600">
        Proxi AI · Internal scheduling
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke test in browser**

Start the dev server:
```bash
npm run dev
```

Navigate to `http://localhost:3000/book`. Verify:
- Dark background loads
- Left panel shows team info and duration toggle
- Center shows current month calendar
- Days without availability are dimmed
- Clicking an available day shows the right panel with time slots
- Clicking a slot shows the booking form
- Submitting navigates to `/book/confirmation`

Navigate to `http://localhost:3000/calendar`. Verify:
- Week grid loads
- Color gradient shows based on busy count
- Prev/Next week navigation works

Navigate to `http://localhost:3000`. Verify:
- List/Board toggle appears above the lead list
- Clicking Board shows the kanban
- Clicking List shows the two-panel view
- The sidebar now shows 4 nav items including Calendar

- [ ] **Step 5: Commit**

```bash
git add src/app/book/page.tsx src/app/book/confirmation/page.tsx
git commit -m "feat: add public booking page and confirmation screen"
```

---

## Self-Review Checklist

- [x] **getFreeBusy** — Task 1 ✓
- [x] **Availability API** — Task 2 ✓ (aggregates all members, 30-min slots)
- [x] **Booking API** — Task 3 ✓ (re-validates, ≥2 free check, creates event with all attendees)
- [x] **ResizeHandle** — Task 4 ✓ (localStorage persistence, min/max constraints)
- [x] **Pipeline toggle** — Task 5 ✓ (List/Board, localStorage, resizable lead list)
- [x] **Sidebar Calendar tab** — Task 6 ✓
- [x] **Internal calendar heatmap** — Task 7 ✓ (8am–8pm PT, 7-day week, color legend)
- [x] **TimeSlotList + BookingForm** — Task 8 ✓ (dark theme, ≥2 free filter, back button)
- [x] **Public /book page** — Task 9 ✓ (cal.com 3-panel dark UI, month calendar, confirmation)
- [x] **No placeholders** — all code is complete
- [x] **Type consistency** — `Slot` interface is defined locally in each component, consistent shape throughout
- [x] **OAuth note** — `calendar` scope already in `buildAuthUrl`; no migration needed
