# Calendar + Nav Restructure — Design Spec
**Date:** 2026-04-06  
**Status:** Approved

---

## Overview

Four changes in one cohesive feature:
1. Nav restructure: 3 tabs → 4 tabs (Pipeline, Calendar, Analytics, Settings)
2. Pipeline page gets a List ↔ Board (kanban/drag-drop) toggle
3. Internal calendar page: shared 3-founder availability heatmap
4. Public booking page (`/book`): cal.com-style scheduling, anyone can book

---

## 1. Navigation Restructure

### Current
```
/ (Pipeline)  |  /analytics  |  /settings
```

### New
```
/ (Pipeline)  |  /calendar  |  /analytics  |  /settings
```

Sidebar `NAV_ITEMS` in `src/components/layout/sidebar.tsx` gets a fourth entry:
```ts
{ href: '/calendar', label: 'Calendar', icon: CalendarDays }
```

### Pipeline tab: List ↔ Board toggle

The existing `/` route (`PipelineView`) gets a toggle button in its header:
- **List** (default): current two-panel view (LeadList + LeadPanel)
- **Board**: the existing `KanbanBoard` from `/pipeline` — move it here, retire the standalone `/pipeline` route

Toggle state stored in `localStorage('proxi-pipeline-view')` so it persists.

---

## 2. Resizable Panels

### Component: `<ResizeHandle>`

Location: `src/components/ui/resize-handle.tsx`

A draggable divider that sits between two panels. On `mousedown`, captures pointer and tracks `mousemove` to compute new width. Persists to `localStorage`.

**Two placements:**
- Between **sidebar** (min 160px, default 208px, max 280px) and main content
- Between **lead list** (min 240px, default 320px, max 480px) and right panel in `PipelineView`

Uses CSS `cursor: col-resize`, `user-select: none` during drag to prevent text selection. Works on touch via `touchmove` equivalents.

---

## 3. Internal Calendar Page (`/calendar`)

### Layout

Standard app shell. Single full-width column.

**Header bar:**
- Month/year label + prev/next week arrows
- "Book a meeting" button (opens the same booking flow as `/book` but pre-filled for internal use)
- "Refresh" icon (re-fetches availability)

**Calendar grid:**
- Shows 2 weeks (14 columns)
- Rows = 30-min slots, 8am–7pm PT (visible range, scrollable)
- Each cell colored by founder busy count:
  - 0 busy → `bg-white` (white)
  - 1 busy → `bg-gray-100`
  - 2 busy → `bg-gray-400`  
  - 3 busy → `bg-gray-800` (near-black)
- Cells with existing CRM events show a pill with the lead name (teal)
- All other events show "Busy" label in gray
- Click on a free cell (0 or 1 busy) → opens "Schedule call" modal with that time pre-filled

### Data source

`GET /api/calendar/availability?start=<ISO>&end=<ISO>`

Returns:
```ts
{
  slots: {
    time: string;          // ISO datetime
    busyCount: number;     // 0-3
    events: {
      title: string;       // lead name or "Busy"
      memberName: string;
      isCrm: boolean;
    }[];
  }[]
}
```

Server calls `calendar.freebusy.query` for each connected member in parallel. For CRM events (identified by `source:proxi_crm` tag in description), the event title is returned. For all others, title is redacted to `"Busy"`.

### OAuth requirement

Requires `https://www.googleapis.com/auth/calendar.readonly` scope.  
If a founder's token lacks this scope, their column shows a "Reconnect" banner. The Settings page shows a similar warning banner.

---

## 4. Public Booking Page (`/book`)

### UI (cal.com dark style)

Dark background (`#111`). Three-column layout:

**Left panel (fixed ~260px):**
- "Proxi AI" team name + avatar initials
- Meeting title: "Quick call"
- Description: "Chat with the Proxi team"
- Duration toggle: **15m** | **30m**
- Google Meet badge
- Timezone selector (defaults to visitor's local timezone, PT shown as reference)

**Center panel:**
- Month calendar grid (Mon–Sun columns)
- Available days (≥1 bookable slot) are clickable with white text
- Unavailable days dimmed (`text-gray-600`)
- Selected day highlighted with white border
- Prev/next month arrows

**Right panel (appears on date select):**
- "Day, Date" header
- 12h / 24h toggle
- List of available time slots as buttons (e.g. "4:30pm ●")
  - Green dot = confirmed available
  - Only slots where ≥2 founders are free are shown

**After slot selection:** inline form slides in:
- Name (required)
- Email (required)
- Optional note
- "Confirm" button

**Confirmation screen:**
- Checkmark animation
- "Meeting confirmed" heading
- Date/time/duration summary
- Google Meet link (big button)
- "Add to calendar" link

### Booking logic

`POST /api/calendar/book` (no auth, rate-limited by IP: 5 bookings/hour)

Request:
```ts
{
  name: string;
  email: string;
  startTime: string;  // ISO
  durationMinutes: 15 | 30;
  note?: string;
  timezone: string;
}
```

Server steps:
1. Re-validate slot: re-run freebusy check to confirm ≥2 founders still free
2. Call `createMeetingEvent` on the **primary** (most available) founder's calendar — `sendUpdates: 'all'` automatically sends invite to all attendees
3. Add the prospect + all 3 founders as attendees in one event → Google sends everyone the invite
4. Return `{ meetLink, eventLink, startTime }`

If slot was taken between page load and submit: return 409, client shows "Slot no longer available — pick another time."

### Availability computation

A slot (time T, duration D) is **bookable** if:
- It is within Mon–Fri, 9am–5pm PT
- ≥2 of the 3 connected founders have no busy block overlapping [T, T+D]
- T is at least 2 hours from now (no last-minute bookings)

---

## 5. New API Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /api/calendar/availability` | `x-team-member-id` | Returns freebusy slots for all members |
| `POST /api/calendar/book` | None (public) | Creates meeting on all 3 calendars |

---

## 6. OAuth Scope Change

Add to the scopes array in `src/app/api/gmail/connect/route.ts`:
```
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events
```

`calendar.readonly` → read freebusy + event titles  
`calendar.events` → create events (needed for booking)

**Migration:** Show a yellow banner in Settings and on the Calendar page for any founder whose token predates the new scopes: "Reconnect Google to enable calendar features."

Detection: after fetching availability, if the API returns a 403, mark that member as `needs_calendar_reauth`.

---

## 7. File Map

### New files
```
src/app/calendar/page.tsx                      — internal calendar view
src/app/book/page.tsx                          — public booking page (no auth)
src/app/book/confirmation/page.tsx             — post-booking confirmation
src/app/api/calendar/availability/route.ts     — freebusy aggregation
src/app/api/calendar/book/route.ts             — booking endpoint (public)
src/components/calendar/availability-grid.tsx  — heatmap grid component
src/components/calendar/time-slot-list.tsx     — right panel time slots
src/components/calendar/booking-form.tsx       — name/email/note form
src/components/ui/resize-handle.tsx            — draggable panel divider
```

### Modified files
```
src/components/layout/sidebar.tsx              — add Calendar nav item
src/components/pipeline/pipeline-view.tsx      — add List/Board toggle
src/app/api/gmail/connect/route.ts             — add calendar scopes
src/lib/google/calendar.ts                     — add getFreeBusy() helper
```

### Retired
```
src/app/pipeline/page.tsx                      — merged into pipeline-view toggle
```

---

## 8. Out of Scope

- Multiple booking types / event types (just one: "Quick call")
- Cancellation / rescheduling flow (out of scope for now)
- SMS notifications
- Buffer time between bookings
- Recurring meetings
