@AGENTS.md

# Proxi CRM — Full Codebase Reference

## What This Is

A custom internal CRM built for **Proxi AI** — a startup building a PM command center (product prioritization tool). The CRM is used exclusively by the 3 co-founders to manage their own outreach pipeline. There is no traditional auth system; instead, the app uses a simple team-member selector that stores a `team_member_id` header on every API request.

**Stack:** Next.js 16.2 (App Router), React 19, TypeScript, Supabase (Postgres + Realtime + Storage), Tailwind CSS v4, shadcn/ui (via `@base-ui/react`), Recharts, dnd-kit, Lucide icons, Sonner toasts, OpenRouter (AI), Vercel (hosting + cron jobs), Resend (email digest).

---

## The Three Co-Founders (hardcoded team members)

Seeded directly in the DB migration — no signup flow:

| Name   | Email              | Role/Notes              |
|--------|--------------------|-------------------------|
| Adit   | aditmittal@berkeley.edu      | Business and CS (Berkeley) |
| Srijay | srijay_vejendla@berkeley.edu | TBD                        |
| Asim   | asim_ali@berkeley.edu        | TBD                        |

`TEAM_NAMES = ['Adit', 'Srijay', 'Asim']` is the canonical constant in `src/lib/constants.ts`.

---

## Phase 11 — Automated Pipeline (added 2026-04-06)

### Stage Label Fix
- `replied` displays as **"Awaiting Reply"** everywhere. DB enum value unchanged.

### Qwen Free Model
- `QWEN_FREE_MODEL = 'qwen/qwen3-14b:free'` in `constants.ts`. Used for auto-followup AI decisions. Update if a different free Qwen model is preferred on OpenRouter.

### Automated Pipeline
- **ICS calendar detection** in `src/lib/gmail/calendar-parser.ts` + `sync.ts`: incremental Gmail sync detects `text/calendar` MIME parts → parses `DTSTART`, organizer, attendees → if email matches a known lead → auto-sets `call_scheduled_for`, advances stage to `scheduled`, bumps priority to `high`
- **Auto-stage cron** every 30 min (`/api/cron/auto-stage`): finds `scheduled` leads where call time passed >30 min ago → creates `call_confirmation` follow-up on dashboard
- **Call confirmation UI** in `pending-followups.tsx`: special indigo card with "Yes, happened" (→ `call_completed`) and "No-show" (dismiss) buttons — no silent auto-advance without human confirmation
- **Auto-followup guard**: only emails leads in `replied` or `scheduling` stages. Never auto-emails leads with scheduled or active calls.

### Lead Management  
- **Contact-email matching** (Path 3 in sync): incremental sync now also matches emails by `contact_email` for manually-added leads without the outreach subject
- **Stage selector** in lead create form — founders can set initial stage when manually adding a lead
- **"Calls" preset** in leads table tab bar — filters to `scheduled + call_completed + post_call`
- **Priority auto-elevation**: entering `scheduled` auto-promotes `low`/`medium` → `high`

### Post-call Timer
- `call_completed` stage creates a `post_call_followup` follow-up due 4h after call
- `computePostCallFollowupHrs(leadId, callCompletedAt)` exported from `stage-logic.ts` — computes hours from call completion to first outbound email

---

## Auth / Session System

No Supabase Auth, no login page. The session is purely:
- A user-selector modal at app startup (`src/components/layout/user-selector-modal.tsx`) stored in `localStorage`
- Every API call sends `x-team-member-id: <uuid>` header
- `src/lib/session.ts` → `getSessionFromRequest()` reads that header and looks up the team member from DB
- The deleted `src/middleware.ts` used to handle this — it's been removed; middleware is no longer used

---

## Lead Pipeline Stages (in order)

```
replied → scheduling → scheduled → call_completed → post_call → demo_sent → active_user
                                                                           ↓
                                                               paused / dead (terminal-ish)
```

- **replied**: Prospect replied to outreach email
- **scheduling**: Trying to book a call
- **scheduled**: Call date is confirmed (`call_scheduled_for` must be set to advance here)
- **call_completed**: Call happened
- **post_call**: Post-call follow-up phase (manual, no automation)
- **demo_sent**: Product demo/access sent
- **active_user**: Using the product
- **paused**: On hold (saves `paused_previous_stage` to restore from)
- **dead**: Lost lead (dismisses all pending follow-ups)

Stage transitions trigger side-effects via `src/lib/automation/stage-logic.ts` — action items and follow-ups are auto-created on `onEnter`.

---

## Gmail OAuth Integration

**Flow:**
1. User clicks "Connect Gmail" on `/settings` → navigates to `/api/gmail/connect?member_id=<id>`
2. That route sets a `gmail_oauth_state` cookie and redirects to Google OAuth consent
3. Google redirects to `/api/gmail/callback` with `?code=...&state=<team_member_id>`
4. Callback validates state cookie, exchanges code for tokens, encrypts both tokens, stores in `team_members` table, then kicks off `runInitialSync()` in the background (fire-and-forget)
5. User is redirected to `/settings?connected=true`

**Token Storage (encrypted):**
- `gmail_access_token` — AES-256-GCM encrypted, stored in DB
- `gmail_refresh_token` — same encryption
- `gmail_token_expiry` — plain timestamp
- Encryption key: `ENCRYPTION_KEY` env var (64 hex chars = 32 bytes)
- Token refresh happens automatically in `src/lib/gmail/client.ts` if expired (refreshes 1 min early, supports token rotation)

**Scopes requested:**
- `gmail.readonly`, `gmail.send`, `gmail.modify`

**Key files:**
- `src/lib/gmail/auth.ts` — `encryptToken`, `decryptToken`, `buildAuthUrl`, `exchangeCodeForTokens`, `refreshAccessToken`
- `src/lib/gmail/client.ts` — `getGmailClientForMember()` — auto-refreshes tokens, returns initialized `googleapis` Gmail client
- `src/lib/gmail/send.ts` — `sendReplyInThread()` — builds RFC 2822 email, sends via Gmail API in existing thread
- `src/lib/gmail/sync.ts` — `runInitialSync()` + `runIncrementalSync()`
- `src/lib/gmail/matcher.ts` — identifies outreach emails by subject pattern

---

## Gmail Sync Logic

**The outreach subject pattern:** `"product prioritization at <Company Name>"`

The matcher (`src/lib/gmail/matcher.ts`) looks for this exact regex:
```
/product prioritization at\s+(.+)/i
```

Only emails matching this subject are synced. Company name is extracted from the subject.

**Initial sync** (`runInitialSync`): Searches Gmail for threads with this subject newer than 2 days where the prospect has replied. Fetches all messages in those threads, processes each one, and stores the Gmail `historyId` for future incremental syncs.

**Incremental sync** (`runIncrementalSync`): Uses Gmail History API from the stored `historyId` to get only new messages since last sync. Falls back to full initial sync if history ID is stale (404).

**Lead creation from email:** Only creates a new lead when an *inbound* (prospect reply) email arrives and no existing lead matches the company + owner. Never creates leads from outbound emails.

**Deduplication:** `interactions` table has a partial unique index on `gmail_message_id` — duplicate messages are silently ignored (`23505` error = expected, not a bug).

**Cron schedule (vercel.json):**
- Email sync: every 5 minutes (`/api/cron/email-sync`)
- Auto followup: every hour (`/api/cron/auto-followup`)
- Stale check: every 4 hours (`/api/cron/check-stale`)
- Daily digest: daily at 16:00 UTC = 8am PT (`/api/cron/daily-digest`)

All cron routes require `Authorization: Bearer <CRON_SECRET>` header.

---

## Auto Follow-up System

**File:** `src/lib/automation/auto-followup.ts`

**Logic:**
1. Finds all active, non-dead, non-paused leads where the last email was *our* outbound email sent >48 hours ago and there has been at least one inbound reply
2. For each qualifying lead, asks Claude Haiku (`anthropic/claude-haiku-4-5` via OpenRouter) whether to follow up and, if so, generates the message
3. The AI decision: `{ should_send: boolean, reason: string, message: string | null }`
4. If `should_send = true`, sends the reply in the existing Gmail thread via `sendReplyInThread()`
5. Logs it as an `email_outbound` interaction with `metadata.auto_followup = true`
6. Records it in `follow_up_queue` as `status: 'sent'`
7. Updates `last_contact_at` on the lead

**The AI is told NOT to send if:** the last email was a natural close ("no worries", "sounds good", "thanks") or following up would feel pushy. Signs off with just the sender's first name.

**Guard:** Skips if there's already a pending `auto_send` follow-up in the queue for that lead.

---

## Stale Lead Detection

**File:** `src/lib/automation/stale-detection.ts`

Stale thresholds per stage (hours without contact):
- `replied`: 4h
- `scheduling`: 48h
- `call_completed`: 4h
- `post_call`: 24h
- `demo_sent`: 5 days (120h)
- `active_user`: 14 days (336h)

Severity: `warning` if past threshold, `critical` if past 2× threshold. Creates `stale_alert` follow-up queue entries (not auto-send, just alerts).

---

## Daily Digest

**File:** `src/lib/automation/digest-builder.ts`

Sent via Resend to all three founders at 8am PT. Contains:
1. Leads that moved forward yesterday (from activity_log)
2. New leads added yesterday
3. Stale leads (top 10 by staleness)
4. Action items due today
5. Summary bar: total active, moved forward, stale count

Sends both HTML (nicely formatted) and plain text versions.

---

## AI Features

All AI calls go through OpenRouter (`src/lib/ai/openrouter.ts`):
- Default model: `anthropic/claude-sonnet-4-20250514`
- Auto follow-up uses: `anthropic/claude-haiku-4-5` (cheaper, fast)
- AI email drafting uses: `deepseek/deepseek-chat-v3-0324` (draft-email route)
- JSON mode via `response_format: { type: 'json_object' }`

**Transcript processing** (`src/lib/ai/transcript-processor.ts`): Full call transcript → structured JSON with summary, sentiment, interest level, next steps, action items, key quotes, pain points, product feedback, follow-up suggestions, and extracted contact info.

**Follow-up drafter** (`src/lib/ai/followup-drafter.ts`): Drafts a 2-3 sentence casual follow-up email in the style of a Berkeley student founder (direct, unpretentious).

**Email compose modal** (`src/components/leads/email-compose-modal.tsx`): Inline compose window in the lead detail page. Has an "AI Draft" button that calls `/api/leads/[id]/draft-email` to generate a draft from the thread context using DeepSeek.

---

## Database Schema (Supabase/Postgres)

### Tables

**`team_members`**
- `id`, `name`, `email`, `major`
- `gmail_access_token` (encrypted), `gmail_refresh_token` (encrypted), `gmail_token_expiry`
- `gmail_connected` (bool), `gmail_history_id` (for incremental sync), `last_gmail_sync`

**`leads`** — the core entity
- Contact: `contact_name`, `contact_email`, `contact_role`, `contact_linkedin`
- Company: `company_name`, `company_url`, `company_stage`, `company_size`
- Ownership: `sourced_by` (FK), `owned_by` (FK), `call_participants` (UUID[])
- Pipeline: `stage` (enum), `priority` (critical/high/medium/low), `heat_score` (0-100)
- Timestamps: `first_reply_at`, `our_first_response_at`, `call_scheduled_for`, `call_completed_at`, `demo_sent_at`, `product_access_granted_at`, `last_contact_at`, `next_followup_at`
- Speed metrics: `time_to_our_response_hrs`, `time_to_schedule_hrs`, `time_to_call_hrs`, `time_to_send_demo_hrs`, `our_avg_reply_speed_hrs`
- Notes: `call_summary`, `call_notes`, `next_steps`, `pinned_note`, `tags` (TEXT[])
- POC: `poc_status` (not_started/preparing/sent/in_review/completed/failed), `poc_notes`
- Pause: `paused_until`, `paused_previous_stage`
- `is_archived` (soft delete)
- Full-text search index on `contact_name + company_name + call_notes + call_summary`

**`interactions`** — immutable event log
- `type`: email_inbound, email_outbound, call, note, demo_sent, follow_up_auto, stage_change, other
- `gmail_message_id` (unique partial index — deduplication key), `gmail_thread_id`
- `subject`, `body`, `summary`, `response_time_hrs`, `metadata` (JSONB)

**`transcripts`** — call recording analysis
- `source_type`: txt_upload, granola_link, paste
- `raw_text`, `file_path` (Supabase Storage)
- All `ai_*` fields stored as JSONB: summary, next_steps, action_items, sentiment, interest_level, key_quotes, pain_points, product_feedback, follow_up_suggestions, contact_info_extracted
- `processing_status`: pending → processing → completed/failed

**`action_items`** — per-lead tasks
- `text`, `assigned_to` (FK), `due_date`, `completed`, `completed_at`
- `source`: manual, ai_extracted, auto_generated
- `sort_order`

**`follow_up_queue`** — scheduled follow-ups
- `type`: auto_email_followup, stale_alert, check_in, auto_send, custom
- `status`: pending, sent, completed, dismissed, overdue, failed
- `auto_send` (bool) — if true, system sends automatically
- `suggested_message`, `gmail_thread_id`, `scheduled_for`

**`activity_log`** — global audit trail (immutable)
- `action`: lead_created, stage_changed, etc.
- `details` (JSONB)

**`email_sync_state`** — per-member Gmail sync state
- `history_id`, `last_sync_at`, `total_synced`

---

## Pages & Navigation

| Route | Description |
|-------|-------------|
| `/` | Dashboard — action items, pending follow-ups, pipeline overview, speed scorecard, stale alert banner, activity feed |
| `/leads` | Lead table with filters, sort, search, bulk actions, CSV export, quick-add FAB |
| `/leads/[id]` | Lead detail — stage stepper, timeline, inline editing, action items, notes, transcript, email compose |
| `/pipeline` | Kanban board (dnd-kit drag-and-drop by stage) |
| `/follow-ups` | Follow-up queue management |
| `/analytics` | Charts: funnel, response speed trend, activity volume, pipeline depth by owner, time-to-demo histogram, weekly retro |
| `/settings` | Gmail connection status + connect/disconnect/manual-sync per member |

---

## API Routes

### Leads
- `GET/POST /api/leads` — list with filters/sort/pagination, create with duplicate detection
- `GET/PATCH/DELETE /api/leads/[id]` — single lead
- `POST /api/leads/[id]/stage` — stage change (triggers automation via `changeStage()`)
- `POST /api/leads/[id]/note` — add note interaction
- `GET/POST /api/leads/[id]/action-items` — list/create action items
- `GET/POST /api/leads/[id]/interactions` — list/create interactions
- `POST /api/leads/[id]/draft-email` — AI-generated email draft (DeepSeek)
- `POST /api/leads/[id]/send-email` — send email via Gmail + log interaction

### Gmail
- `GET /api/gmail/connect` — initiates OAuth (sets state cookie, redirects to Google)
- `GET /api/gmail/callback` — OAuth callback handler
- `POST /api/gmail/disconnect` — clears tokens
- `GET /api/gmail/status` — connected/disconnected per member
- `POST /api/gmail/sync` — manual incremental sync trigger

### Cron (POST, require `CRON_SECRET`)
- `/api/cron/email-sync` — incremental Gmail sync for all connected members
- `/api/cron/auto-followup` — AI auto follow-up runner
- `/api/cron/check-stale` — stale lead detection + queue entries
- `/api/cron/daily-digest` — build + send digest via Resend

### Analytics
- `GET /api/analytics/funnel` — stage counts + conversion rates
- `GET /api/analytics/speed` — avg response time per week per member (line chart data)
- `GET /api/analytics/activity` — email + interaction volume per week (bar chart data)
- `GET /api/analytics/source` — pipeline depth by owner (avg stage score + lead count)
- `GET /api/analytics/retro` — weekly retro data (moved forward, new leads, stale)

### Other
- `GET /api/dashboard` — all dashboard data in one call
- `GET /api/search` — global search
- `GET /api/session` — current session info
- `PATCH/DELETE /api/action-items/[id]` — update/delete action items
- `GET/PATCH/DELETE /api/follow-ups/[id]` — follow-up queue management
- `POST /api/transcripts/upload` — upload + store transcript (triggers async processing)
- `POST /api/transcripts/[id]/process` — AI transcript analysis

---

## Realtime

`src/hooks/use-realtime.ts` — `useLeadRealtime(callback)` subscribes to Supabase Realtime `postgres_changes` on the `leads` table. Used in the lead table and pipeline views to auto-refresh when any lead changes.

---

## Key Patterns & Conventions

1. **No middleware** — `src/middleware.ts` was deleted. Session is read from `x-team-member-id` header in each API route via `getSessionFromRequest()`.

2. **Admin client only** — All server-side DB access uses `createAdminClient()` (service role key), not the anon client. The anon client (`createClient()`) is only used client-side for Supabase Realtime subscriptions and direct queries from pages.

3. **Optimistic UI** — Lead detail page updates state immediately on edit, rolls back on error.

4. **Stage validation** — The `scheduled` stage requires `call_scheduled_for` to be set before transitioning. Enforced in `stageRegistry` in `stage-logic.ts`.

5. **Duplicate detection** — When creating a lead via API, checks for existing leads with same email OR same name+company combo.

6. **Inline editing** — Lead names, company, role, call notes all use `InlineEdit` component (click to edit, Enter to save).

7. **Stale alerts** — `StaleAlertBanner` on dashboard counts stale leads. Per-stage thresholds are in `STALE_THRESHOLDS` constant.

8. **Heat score** — `heat_score` (0-100, default 50) is shown as a flame icon on lead detail. Color: red ≥70, orange ≥40, gray below.

9. **Speed color coding** — `SPEED_COLOR(hrs)`: green <2h, yellow <8h, orange <24h, red ≥24h.

10. **Google Calendar integration** — Lead detail has a "Schedule" button that opens Google Calendar's event creation URL pre-filled with lead contact + all other team members as guests, 15-min meeting tomorrow at 10am PT.

---

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL       — Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY  — Supabase anon key (client-side)
SUPABASE_SERVICE_ROLE_KEY      — Supabase service role (server-side, admin)
OPENROUTER_API_KEY             — OpenRouter for all AI calls
GOOGLE_CLIENT_ID               — Google OAuth app client ID
GOOGLE_CLIENT_SECRET           — Google OAuth app client secret
GOOGLE_REDIRECT_URI            — OAuth callback URL (e.g. https://app.proxi.ai/api/gmail/callback)
RESEND_API_KEY                 — Resend for daily digest emails
NEXT_PUBLIC_APP_URL            — App base URL (used in OAuth redirects)
CRON_SECRET                    — Bearer token for cron route auth
ENCRYPTION_KEY                 — 64 hex chars (32 bytes) for AES-256-GCM token encryption
```

---

## Migrations (in order)

1. `001_initial_schema.sql` — All core tables + seed 3 team members + indexes
2. `002_add_contact_info_extracted.sql` — Adds `ai_contact_info_extracted` JSONB column to transcripts
3. `003_phase8_gmail.sql` — Adds `gmail_token_expiry`, `gmail_history_id`, `last_gmail_sync` to team_members; adds `scheduled_for`, `message_template`, `gmail_thread_id` to follow_up_queue
