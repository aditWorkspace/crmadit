# Automated Cold Outreach — Design Spec

**Status:** Approved — ready for implementation planning
**Date:** 2026-04-28
**Owner:** Adit
**Estimated effort:** ~15 working days across 5 PRs, then 1-day soft warmup before steady state

---

## 1. Problem & goals

The 3 founders currently send ~400 cold-outreach emails per Gmail account per day, manually. Each morning one of them logs into Gmail and triggers a YAMM/Mailmeteor merge against a CSV produced by the existing `email-tool`. This is a daily ~30-minute manual chore that is error-prone, easy to skip, and creates a tight coupling between human availability and outbound volume.

**Goal:** replace the manual send step with a fully automated, schedule-driven pipeline that:
- Sends ~300–400 emails per founder per day across all 3 founders' Gmail accounts
- Operates safely within Gmail's per-account daily quotas and per-second rate limits
- Mimics human-pattern sending (jittered timing, content variants, no template fingerprinting) to minimize the chance of accounts being throttled or banned
- Is observable and pause-able the moment something goes wrong
- Supports ad-hoc priority sends (e.g., a hand-curated list of YC partners) without disrupting the regular pool
- **Treats every outbound send as a first-class CRM event** — auto-creates a lead, logs the interaction, attributes the variant + campaign, and produces per-variant / per-founder / per-campaign analytics that founders never had with external tools (see §12)

**Non-goals (deliberately deferred):**
- HTML emails / attachments / inline images
- Open-tracking pixels or click tracking
- A/B testing framework with statistical winner selection
- Custom outreach domain (`proxiapp.com` or similar) — Phase 2 follow-up after this ships
- Postmaster Tools enrollment — depends on owning a sending domain
- Multi-account fan-out beyond the 3 founders' Workspace accounts
- Auto-resume from critical pauses (always requires human action)

---

## 2. Research findings & constraints

### Gmail caps (current as of 2026)
- **Free `@gmail.com` via Gmail API:** 500 recipients per 24h
- **Google Workspace via Gmail API:** 2,000 messages/day, 2,000 *external* recipients/day
- **Per-user-per-second:** ~2.5 sends/sec ceiling; bursts above this return `429 userRateLimitExceeded`
- **Daily-cap breach:** `403 dailyLimitExceeded`; `403 quotaExceeded` indicates account flag (potentially 24h+ lockout)
- Founders send from `@berkeley.edu` accounts — paid Workspace tier, so 2,000/day external is the hard ceiling

### Soft signals that flag/ban accounts (regardless of staying under caps)
- Spam complaint rate >0.3% (industry threshold enforced by Gmail since May 2025)
- Hard-bounce rate >2%
- Burst sending — even within daily cap, hundreds/hour gets flagged
- Identical content fingerprinting across recipients
- Sudden volume jumps (warmup violations)
- Tracking pixels from shared/non-owned domains
- Same recipient domain hit multiple times same day from same sender

### Volume target & math
- 3 accounts × 350/day steady = 1,050 emails/day total
- Spread over 3 hours (5:30–8:30am drift window): 350 ÷ 180 min = ~2 sends/min/account
- Average inter-send gap per account: ~30 seconds
- Well below Gmail's 2.5 sends/sec ceiling and 2,000/day external cap

### What YAMM and Mailmeteor do (the patterns we mirror)
- Send via the user's own Gmail OAuth (not third-party SMTP)
- Pace sends with configurable inter-message delays
- Pause on `insufficient_quota` and resume the next day
- Append `List-Unsubscribe` header to every send
- Include one-click unsubscribe (RFC 8058) for deliverability boost
- Limited spintax for greeting/sign-off variation
- Lint templates against spammy patterns before save

### Postmaster Tools limitation
Berkeley owns `berkeley.edu`, not us. We cannot enroll the sending domain in Postmaster Tools, which means we have no direct visibility into spam complaint rate. We rely on indirect proxies (bounce rate, reply rate, 403 errors). This is the primary motivation for the Phase 2 custom-domain migration.

---

## 3. Architecture overview

```
                 ┌────────────────────────────────┐
                 │ DAILY TRIGGER  (cron-job.org)  │
                 │ Fires at email_send_schedule.next_run_at
                 └───────────────┬────────────────┘
                                 ▼
                ┌─────────────────────────────────┐
                │ POST /api/cron/email-tool/start │
                │  ① Kill switch / pause check    │
                │  ② Skip-next-run check           │
                │  ③ Priority-list pull            │
                │  ④ Pool pick + reservation       │
                │  ⑤ Round-robin assignment        │
                │  ⑥ Domain-dedup pass             │
                │  ⑦ Template variant pick         │
                │  ⑧ Slot scheduling (jittered)    │
                │  ⑨ Queue insert                  │
                │  ⑩ Schedule advance              │
                └───────────────┬─────────────────┘
                                ▼
                  email_send_queue (status=pending)
                                ▼
                ┌─────────────────────────────────┐
                │ EVERY MINUTE  (vercel cron)     │
                │ POST /api/cron/email-tool/tick  │
                │  ① Crash recovery sweep          │
                │  ② Per-tick safety checks        │
                │  ③ Pull due rows (≤30/tick)      │
                │  ④ Render template + send        │
                │  ⑤ Apply error policy            │
                │  ⑥ Update status / blacklist     │
                └───────────────┬─────────────────┘
                                ▼
                  Gmail (delivered to prospect)
```

**Two-stage rationale:** the morning trigger does the scheduling work in <30 seconds. The minute-tick drains the queue over 3 hours. Vercel's 5-minute function timeout would otherwise force us to use a queue anyway; this design makes the queue the source of truth and makes ticks idempotent.

---

## 4. Data model

All additions are pure-additive. Existing tables (`email_pool`, `email_blacklist`, `email_pool_state`, `team_members`) untouched except for new columns on `team_members`.

### 4.1 New tables

Migration ordering matters (FK dependencies). The migration creates tables in this order: `email_send_campaigns` → `email_template_variants` → `email_send_priority_queue` → `email_send_queue` → `email_send_schedule`. The `email_send_priority_queue.campaign_id` FK is added via `ALTER TABLE` *after* both `priority_queue` and `campaigns` exist (campaigns exists first, but the constraint is added last to keep the dependency graph linear).

```sql
-- 1) Per-day campaign run record (no FKs out)
CREATE TABLE email_send_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_for   TIMESTAMPTZ NOT NULL,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending | running | done | aborted | paused | exhausted | skipped
  total_picked    INT DEFAULT 0,
  total_sent      INT DEFAULT 0,
  total_failed    INT DEFAULT 0,
  total_skipped   INT DEFAULT 0,
  abort_reason    TEXT,
  warmup_day      INT,            -- day 1 = 250/account, day 2+ = 350/account
  created_by      UUID REFERENCES team_members(id),  -- null = cron
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON email_send_campaigns (status, scheduled_for);

-- 2) Per-founder template library (FK to team_members only)
CREATE TABLE email_template_variants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id          UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  subject_template    TEXT NOT NULL,
  body_template       TEXT NOT NULL,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(founder_id, label)
);
CREATE INDEX ON email_template_variants (founder_id, is_active);

-- 3) Priority CSV override input queue (FK to campaigns added later)
CREATE TABLE email_send_priority_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL CHECK (email = lower(email)),
  first_name          TEXT,
  company             TEXT,
  uploaded_by         UUID NOT NULL REFERENCES team_members(id),
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_for_date  DATE NOT NULL,
  notes               TEXT,
  override_blacklist  BOOLEAN NOT NULL DEFAULT FALSE,
  override_owner      UUID REFERENCES team_members(id),
  -- if NULL: round-robin like pool rows; if set: force-assign to this founder
  status              TEXT NOT NULL DEFAULT 'pending',
  -- pending | scheduled | sent | skipped | cancelled
  campaign_id         UUID,            -- FK added below after both tables exist
  last_error          TEXT
);
CREATE INDEX ON email_send_priority_queue (scheduled_for_date, status);
CREATE UNIQUE INDEX ON email_send_priority_queue (email, scheduled_for_date)
  WHERE status IN ('pending','scheduled');

-- 4) Individual send slot (FKs to campaigns, team_members, variants, priority_queue)
CREATE TABLE email_send_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES email_send_campaigns(id) ON DELETE CASCADE,
  account_id          UUID NOT NULL REFERENCES team_members(id),
  recipient_email     TEXT NOT NULL CHECK (recipient_email = lower(recipient_email)),
  recipient_name      TEXT,
  recipient_company   TEXT,
  template_variant_id UUID NOT NULL REFERENCES email_template_variants(id),
  send_at             TIMESTAMPTZ NOT NULL,    -- jittered slot
  status              TEXT NOT NULL DEFAULT 'pending',
  -- pending | sending | sent | failed | skipped
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  sending_started_at  TIMESTAMPTZ,             -- crash recovery marker
  sent_at             TIMESTAMPTZ,
  gmail_message_id    TEXT,
  source              TEXT NOT NULL DEFAULT 'pool',  -- pool | priority
  priority_id         UUID REFERENCES email_send_priority_queue(id),  -- nullable
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, recipient_email)
);
CREATE INDEX ON email_send_queue (status, send_at) WHERE status = 'pending';
CREATE INDEX ON email_send_queue (account_id, sent_at);
CREATE INDEX ON email_send_queue (campaign_id, status);

-- 5) Schedule singleton (drift state, FK-free)
CREATE TABLE email_send_schedule (
  id                    INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  anchor_at             TIMESTAMPTZ NOT NULL,        -- e.g. '2026-05-04 05:30:00 PT'
  day_index             INT NOT NULL DEFAULT 0,
  drift_per_day_min     INT NOT NULL DEFAULT 15,
  drift_cap_local_hour  INT NOT NULL DEFAULT 13,     -- 1pm PT — wrap point
  warmup_started_on     DATE,                        -- null until enabled flipped on
  warmup_day_completed  INT NOT NULL DEFAULT 0,      -- gate for Day 1 → Day 2 ramp
  skip_next_run         BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at           TIMESTAMPTZ,
  next_run_at           TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO email_send_schedule (id, anchor_at) VALUES (1, '2026-05-04 12:30:00+00') ON CONFLICT DO NOTHING;
-- ^ anchor in UTC; computed PT 5:30am. Adjust at deploy time.

-- 6) Add the cross-table FK on priority_queue.campaign_id
ALTER TABLE email_send_priority_queue
  ADD CONSTRAINT fk_priority_campaign
  FOREIGN KEY (campaign_id) REFERENCES email_send_campaigns(id);
```

### 4.2 New columns on `team_members`

```sql
ALTER TABLE team_members
  ADD COLUMN email_send_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN email_send_paused_reason TEXT,
  ADD COLUMN email_send_paused_at TIMESTAMPTZ;
```

### 4.3 Hard-coded safety constants (NOT in the database)

```typescript
// src/lib/email-tool/safety-limits.ts
export const SAFETY_LIMITS = {
  ABSOLUTE_DAILY_CAP_PER_ACCOUNT:                 400,    // hard ceiling
  WARMUP_DAY_1_CAP:                               250,
  WARMUP_DAY_2_PLUS_CAP:                          350,
  MIN_INTER_SEND_GAP_SECONDS:                     10,
  MAX_INTER_SEND_GAP_SECONDS:                     120,
  MAX_CAMPAIGN_DURATION_HOURS:                    4,
  MAX_SENDS_PER_DOMAIN_PER_ACCOUNT_PER_DAY:       1,
  BOUNCE_RATE_PAUSE_THRESHOLD:                    0.05,
  TICK_BUDGET_SENDS_PER_RUN:                      30,
  TICK_BUDGET_DURATION_SECONDS:                   240,
  CRASH_RECOVERY_STALE_MINUTES:                   10,
  PRIORITY_BATCH_MAX_ROWS_PER_UPLOAD:             500,
  POOL_LOW_WATER_DAYS:                            5,
} as const;
```

These cannot be changed via UI; they require a code commit.

---

## 5. Daily flow (`/api/cron/email-tool/start`)

Triggered once per day by cron-job.org at `email_send_schedule.next_run_at`. All steps run inside a single function invocation in <30 seconds.

```
① Kill-switch check
   • Read email_send_schedule.enabled — if false, exit
   • Read team_members.email_send_paused for all founders
   • If ALL 3 founders paused → record campaign as 'paused', alert, exit
   • If 1–2 paused → continue with the remaining founders only

② Skip-next-run check
   • Read email_send_schedule.skip_next_run
   • If true:
       - schedule.skip_next_run = false
       - schedule.day_index += 1                  (drift continues)
       - recompute next_run_at
       - record campaign as 'skipped'
       - alert founders
       - exit

③ Priority list pull
   • SELECT * FROM email_send_priority_queue
       WHERE scheduled_for_date = today
         AND status = 'pending'
       ORDER BY uploaded_at, id
   • priority_n = count of those rows

④ Daily cap math + pool pick
   • active_founder_count = number of founders NOT in email_send_paused state
       (if 0 → record campaign as 'paused', alert, exit)
   • Warmup gate (the Day 1 → Day 2 ramp guard):
       prev = most-recent email_send_campaigns row with status IN ('done','exhausted')
       if schedule.warmup_day_completed == 0:
         daily_cap_per_acct = WARMUP_DAY_1_CAP (250)
       else if schedule.warmup_day_completed == 1:
         if prev.bounce_rate < 0.03 AND prev.had_no_auto_pauses AND prev.hard_5xx < 5:
           daily_cap_per_acct = WARMUP_DAY_2_PLUS_CAP (350)
         else:
           daily_cap_per_acct = WARMUP_DAY_1_CAP (250)   -- stay until clean
       else:
         daily_cap_per_acct = WARMUP_DAY_2_PLUS_CAP (350)
   • daily_target = daily_cap_per_acct × active_founder_count
   • capped_priority_n = min(priority_n, daily_target)
   • If priority_n > daily_target:
       - take first capped_priority_n by uploaded_at
       - mark the rest status='skipped', last_error='daily_cap_exceeded'
       - alert admin
   • regular_target = daily_target − capped_priority_n
   • If regular_target > 0:
       - rows = email_tool_pick_batch(p_limit := regular_target)
       - if rows.length < regular_target → run a smaller campaign with what's there
   • combined = priority_rows ⊕ pool_rows

⑤ Round-robin assignment
   • For each row in combined (in input order):
       - if priority row has override_owner set → assign to that founder
       - else → assign to founders[i % active_founder_count]
   • Skip paused founders in the rotation

⑥ Domain-dedup pass (per founder)
   • For each founder's chunk:
       - group by lower(email_domain)
       - if any group has >1 row, keep first, return rest to unscheduled state
   • Pool rows returned: rolled back from blacklist (un-blacklist)
   • Priority rows returned: status reset to 'pending', alerted to admin

⑦ Template variant pick (per recipient)
   • For each row, uniform_random() over founder's active variants
   • If founder has 0 active variants → that founder's chunk is dropped, alert

⑧ Slot scheduling (per founder, independent jitter)
   • cursor = campaign_start + random(0, 30s)
   • for each send in chunk:
       slot = cursor
       cursor += random(15s, 45s) clamped to [10s, 120s]
   • If total span > MAX_CAMPAIGN_DURATION_HOURS → abort, alert (shouldn't happen at 350)

⑨ Bulk insert into email_send_queue
   • One row per recipient × variant × slot
   • status='pending'

⑩ Priority queue update + schedule advance
   • UPDATE email_send_priority_queue SET status='scheduled', campaign_id=...
   • email_send_schedule.day_index += 1
   • email_send_schedule.last_run_at = now()
   • email_send_schedule.next_run_at = compute_next()
   • If campaign reached steady-state cap (350) and warmup_day_completed < 2:
       email_send_schedule.warmup_day_completed += 1
   • email_send_campaigns SET status='running', started_at=now()
   • Function returns
```

### 5.1 Schedule drift logic (cap-and-wrap)

```typescript
function computeNextRunAt(schedule): Date {
  const baseUtc = schedule.anchor_at;
  const daysFromAnchor = schedule.day_index + 1;
  const driftMinutes = daysFromAnchor * schedule.drift_per_day_min;
  const tentative = baseUtc + days(daysFromAnchor) + minutes(driftMinutes);
  
  const ptHour = ptHourOf(tentative);
  if (ptHour >= schedule.drift_cap_local_hour) {
    // Wrap: skip ahead to next day at anchor PT time, reset drift
    const wrapped = nextDayAtPtTime(tentative, ptHourOf(baseUtc), ptMinuteOf(baseUtc));
    schedule.day_index = 0;  // drift resets at wrap (persisted on next run)
    return wrapped;
  }
  return tentative;
}
```

The wrap day produces one ~17-hour gap (e.g., yesterday 12:45pm → today 5:30am), which is intentional — it's the price of staying in business hours. Drift then restarts from 5:30am.

---

## 6. Minute-tick flow (`/api/cron/email-tool/tick`)

Triggered every minute by Vercel's native cron. Drains `email_send_queue`.

```
① Crash recovery sweep
   UPDATE email_send_queue
   SET status='pending', sending_started_at=NULL
   WHERE status='sending'
     AND sending_started_at < now() - interval '10 minutes'

② Pause check + stale-account filter
   • Read paused state for all founders; filter from candidate set

③ Pull due rows
   SELECT id, account_id, ... FROM email_send_queue
   WHERE send_at <= now()
     AND status = 'pending'
     AND account_id IN (active accounts)
   ORDER BY send_at
   LIMIT 30
   FOR UPDATE SKIP LOCKED
   • UPDATE selected rows SET status='sending', sending_started_at=now()

④ For each row:
   ④a Per-tick safety checks (in order, fail-fast):
       • Bounce-rate check (this account, last 7d) — pause if >5%
       • Per-second pace (since last sent for this account) — defer +15s if <10s
       • Recipient-domain check (race-safe re-verify) — skip if already sent today
       • Reply-since-queue check (recipient → us, last 4h) — status='skipped'
       • Variant active check — status='failed' if 0 active variants for founder
   
   ④b Render template:
       • Look up email_template_variants by ID
       • Substitute {{first_name}}, {{company}}, {{founder_name}}
       • Apply spintax (greeting/sign-off only): {{ RANDOM | a | b | c }}
       • HTML-escape merge values (defense in depth, plain text anyway)
   
   ④c Build and send via Gmail API:
       From:           "{{founder_full_name}}" <{{founder_email}}>
       To:             {{recipient_email}}
       Subject:        rendered subject
       Reply-To:       {{founder_email}}
       List-Unsubscribe: <mailto:{{founder_local}}+unsubscribe@berkeley.edu?subject=unsubscribe>
       List-Unsubscribe-Post: List-Unsubscribe=One-Click
       Precedence:     bulk
       X-Priority:     3
       MIME:           text/plain; charset=utf-8
       Body:           rendered body (NO unsubscribe footer)
   
   ④d Apply error policy:
       success → status='sent', sent_at=now(), gmail_message_id stored
       429 userRateLimitExceeded → exponential backoff (5s/30s/2m), max 3 retries,
                                   then status='failed'
       403 dailyLimit/quotaExceeded → set founder.email_send_paused=true with reason,
                                       mark campaign 'paused' if all founders paused,
                                       send critical alert via Resend, EXIT TICK
       Hard bounce 5xx → INSERT INTO email_blacklist, status='skipped'
       Soft bounce 4xx → status='failed' (no retry until next campaign)
       Other 5xx → status='failed' with last_error

⑤ Per-tick budget cap
   • Exit after 30 sends OR 240 seconds, whichever first

⑥ Campaign completion check
   • If 0 pending rows for this campaign → mark 'done', completed_at=now()
   • Trigger daily-digest update (handled by separate cron, just updates campaign row)
```

---

## 7. Templates + content

### 7.1 Constraints
- Plain text only (`text/plain; charset=utf-8` MIME, no HTML alternative)
- No attachments, no inline images
- No tracking pixels, no link redirection
- No auto-injected unsubscribe footer in body — recipient sees a 1:1-looking email
- `List-Unsubscribe` header is the ONLY visible-to-Gmail bulk signal

### 7.2 Per-founder requirements
- Minimum **2 active variants** before campaigns can run for that founder
- Maximum: unlimited (practical: 4–6)
- Each variant: subject_template + body_template + label

### 7.3 Merge tags
- `{{first_name}}` — falls back to `"there"`
- `{{company}}` — falls back to `"your company"`
- `{{founder_name}}` — sending founder's first name (rendered live, not at queue time)

### 7.4 Limited spintax (greetings/sign-offs only)
Syntax: `{{ RANDOM | option_a | option_b | option_c }}`

The author marks the swappable spans explicitly. Examples:
```
{{ RANDOM | Hi | Hey | Hello }} {{first_name}},
...
{{ RANDOM | Cheers | Thanks | Best }},
{{founder_name}}
```

We deliberately do NOT support spintax in body sentences — that path leads to unnatural-sounding sentences. Author-marked spans only.

### 7.5 Pre-save lint

Hard blockers (cannot save):
- Body contains `unsubscribe`, `STOP`, or `opt-out` (we don't auto-inject those, but if author types them, blocked to keep the 1:1 look)
- Body contains URL shorteners: `bit.ly`, `tinyurl`, `t.co`, `goo.gl`, `tiny.cc`, etc.
- Subject contains `noreply`, `do-not-reply`
- Body length <30 or >800 chars

Warnings (savable with confirmation):
- >2 links in body
- Subject >80 chars
- Subject in ALL CAPS for >5 consecutive chars
- Body lacks both `{{first_name}}` and `{{company}}` (no personalization)
- Words from spammy list: `free`, `winner`, `act now`, `limited time`, `guarantee`, `100%`, `$$$`

### 7.6 Templates UI

Located at `/email-tool/admin/templates` (admin-only).

Per-founder section listing variants with:
- Active toggle
- Edit / Delete actions
- Subject preview
- Body preview (first 80 chars)

Edit modal:
- Plain-text editor
- Live preview pane: renders with sample data (`first_name="Sample"`, `company="Acme Corp"`, `founder_name=<current>`)
- Spintax preview: shows N=3 random rolls
- Lint runs on input change; save button disabled while blockers present
- Save shows confirmation dialog if warnings present

---

## 8. Reply detection (two-layer)

### Layer 1: Pre-pick filter (at `/start` step ④)
For each candidate pool row, check if `recipient_email` matches any CRM lead with an inbound interaction in the last 90 days. If yes, silently skip (treat as already-blacklisted). Catches the case where someone replied via a different thread / different lead-creation path that the standard blacklist missed.

### Layer 2: Pre-send check (at tick step ④a)
Right before sending, query: has this `recipient_email` sent us anything in the last 4h? If yes, skip with `status='skipped', last_error='replied_during_campaign'`. Catches the race where someone replies to a 5:30am send (delivered to founder A's inbox) before founder B's slot to the same recipient hits at 7:30am.

Cost: 1 indexed query per send (cheap).

---

## 9. Skip One Day toggle

UI at `/email-tool/admin/schedule`. Button labeled `Skip tomorrow's run`.

Click flow:
- POST to `/api/cron/email-tool/schedule/skip` (admin-gated)
- Sets `email_send_schedule.skip_next_run = true`
- UI shows banner: "Tomorrow's automated send will be skipped. The schedule resumes [day after]."
- Banner has Undo link until midnight tonight (clears the flag)

Behavior:
- Single-shot — skipping repeatedly requires repeated clicks
- `day_index` increments anyway → drift continues, slot is forfeited
- Founders alerted via Resend that the day was skipped

---

## 10. Priority CSV Override

### 10.1 Upload UI

Located at `/email-tool/admin/priority`. Admin-only.

Inputs:
- Schedule for: dropdown of next 7 days, default = next campaign date (with actual time shown per drift schedule)
- CSV upload: columns `email`, `first_name`, `company`
- OR paste box: comma- or newline-separated emails (names auto-derived if not provided)
- Notes (optional batch label)

### 10.2 Validation step

Before insert, validate the upload:
- Email format
- Cap: max 500 rows per upload (`PRIORITY_BATCH_MAX_ROWS_PER_UPLOAD`)
- Already in `email_blacklist` — show warning, admin can override
- Matches existing CRM lead with `stage='dead'` — block (or override)
- Matches existing CRM lead with active stage — show "lead owner" attribution option:
  - **(c) Round-robin but show UI checkbox per upload** — chosen
  - Default-checked: "Use lead owner for matched rows" (preserves continuity)
  - Unchecking: those rows go through round-robin like new contacts

### 10.3 Insert

After admin confirms validation:
- Bulk INSERT into `email_send_priority_queue`
- For lead-owner-matched rows where checkbox was checked → set `override_owner = lead.owned_by`
- For all other rows → `override_owner = NULL` (round-robin at /start)
- `status = 'pending'`
- `scheduled_for_date = chosen date`
- `override_blacklist = true` only for rows where admin clicked override

### 10.4 /start route consumption

Step ③ (priority pull) reads pending priority rows for today. They merge into the combined input list at step ⑤. Override-owner rows skip round-robin; others enter the rotation alongside pool rows.

Step ⑩ updates priority rows: `status='scheduled'`, `campaign_id=<this campaign>`. Their emails also get added to `email_blacklist` so they're never re-picked from pool.

### 10.5 Cancellation

A "Scheduled for tomorrow" tab on the priority page lists pending rows grouped by upload. Admin can:
- Cancel an entire batch — DELETE rows
- Cancel individual rows — `status='cancelled'`

After /start runs and rows are in `email_send_queue`, cancellation moves to the per-account pause buttons (already covered).

---

## 11. Health monitoring + alerts

### 11.1 Health dashboard

Located at `/email-tool/admin/health`. Per-founder card:

```
Status:        ✅ Healthy / ⚠ Warning / 🔴 Paused
Sends today:   X / cap (warmup day Y)
Sends last 7d: total
Bounce rate (7d):   X.X%   threshold 5%
Reply rate (7d):    X.X%   threshold ≥0.5% over 200 sends
Auto-pauses (30d):  N
Last send:     timestamp + recipient
Next send:     ETA
[ Pause ] [ View campaigns ]
```

Aggregate top row: pool remaining (days), today's totals, all-accounts health.

### 11.2 Alert tiers (all routed to all 3 founders via existing Resend infra)

| Tier | Trigger | Latency |
|---|---|---|
| 🔴 Critical | 403 dailyLimit/quotaExceeded; OAuth revoked; bounce rate >5%; campaign aborted | Immediate (during tick) |
| 🟡 Warning | Bounce rate >3%; reply rate <0.5% over 200 sends; warmup-skip toggled; pool <5 days | Daily digest |
| 🟢 Info | Campaign completed; pool refilled; priority batch scheduled | Daily digest |

Critical alerts include account name, error code, and a 1-click resume link signed with a short-lived token.

### 11.3 Auto-pause matrix

| Trigger | Scope | Recovery |
|---|---|---|
| 403 dailyLimitExceeded | This account | Auto-resume next day |
| 403 quotaExceeded (account flag) | This account | **Manual** resume only |
| OAuth token revoked | This account | Reconnect Gmail, then manual resume |
| 7-day bounce rate >5% | This account | Manual resume after list-quality fix |
| Tick handler crashes 3× in 10min | All accounts | Manual resume + log review |
| Admin clicks "Pause All" | All accounts | Manual resume |

Resume is always an explicit human action — no auto-un-pause on serious flags.

---

## 12. CRM integration benefits — what we get for free

Sending from inside the CRM (vs. handing a CSV to YAMM externally) unlocks a set of integrations that are either impossible or much harder when sending lives outside our system. Listing these here both as a feature inventory and as the rationale for *why* this build is worth more than just "automate the manual send."

### 12.1 Auto-create leads from outbound sends

Today, a `leads` row is created only when a prospect *replies* to outreach. The Gmail-sync matcher handles inbound reply detection. This means we have no record of "everyone we've ever cold-emailed" — only "everyone who replied."

With in-CRM sends, every outbound email becomes a lead at send time. The pre-built `createLeadFromOutreach()` helper at `src/lib/leads/auto-create.ts` (already shipped, currently unused) is the exact API:
- `email`, `fullName`, `company` populated from the send queue row
- `ownedBy` = the founder who actually sent (round-robin assignment)
- `source` = `'mass_email'`
- Idempotent: existing leads update `last_contact_at`; new leads insert with `stage='replied'` (placeholder until reply arrives) — actually we use a new stage value `outreach_sent` for sent-but-not-replied (see schema additions below)

Result: founders can see in the lead pipeline *every* prospect they've ever reached out to, not just the ~3% who replied. Surfaces the long tail of "we contacted 200 people at YC-backed companies last month" as queryable data.

### 12.2 Per-send interaction logging at send time

Today, the existing Gmail sync picks up sent items hours later (5-min cron lag) and writes `interactions` rows with `type='email_outbound'`. Lag means dashboards are always stale.

With in-CRM sends, the tick handler writes the interaction row at the same moment as the Gmail API call succeeds. Fields populated:
- `lead_id` — the lead from §12.1
- `team_member_id` — the sending founder
- `type` = `'email_outbound'`
- `subject` — rendered subject after merge tags
- `body` — rendered body after merge tags
- `gmail_message_id` — returned from Gmail API; needed for §12.3
- `gmail_thread_id` — same
- `metadata.rfc_message_id` — RFC 5322 Message-Id we set, for cross-account threading
- `campaign_id` — NEW column linking interaction to campaign (§12.8)
- `template_variant_id` — NEW column linking interaction to variant (§12.8)
- `occurred_at` — Gmail's reported send time

Result: instant timeline updates on the dashboard the moment a send completes. No 5-minute Gmail-sync round-trip.

### 12.3 Reply attribution via Message-ID

When the prospect replies, their reply has an `In-Reply-To: <our-message-id>` header (RFC 5322 standard). The existing Gmail sync already extracts this and matches replies to outbound interactions via `gmail_thread_id`.

With in-CRM sends, we store our own `gmail_message_id` and `rfc_message_id` at send time, so the matcher's accuracy goes from "thread-based" (works ~95% of the time) to "exact message ID" (100%). We can also populate the lead's `first_reply_at` with the interaction's `occurred_at` precisely.

Result: closed-loop attribution. We know exactly which campaign + variant drove which reply.

### 12.4 Per-variant, per-founder, per-campaign performance analytics

Once §12.2 + §12.3 are wired, the following metrics fall out of simple SQL queries:

```sql
-- Per-variant reply rate (last 30 days)
SELECT
  v.label,
  v.founder_id,
  COUNT(i.id) FILTER (WHERE i.type = 'email_outbound')                 AS sent,
  COUNT(DISTINCT l.id) FILTER (WHERE l.first_reply_at IS NOT NULL)     AS replied,
  ROUND(100.0 * replied / NULLIF(sent, 0), 1)                          AS reply_rate_pct
FROM email_template_variants v
LEFT JOIN interactions i ON i.template_variant_id = v.id
LEFT JOIN leads l ON l.id = i.lead_id
WHERE i.occurred_at > now() - interval '30 days'
GROUP BY v.id, v.label, v.founder_id
ORDER BY reply_rate_pct DESC;
```

Variations: per-founder, per-campaign, per-week trend, per-recipient-domain success rate.

These plug into the new health dashboard (§11.1) as additional cards:
- "Top-performing variants this week"
- "Adit's reply rate trend (4-week sparkline)"
- "Last campaign: 350 sent, 28 replied (8% — 2pp above 30-day average)"

Founders get the iteration data they've never had before. Variants that consistently underperform get retired; high-performers get cloned and tweaked.

### 12.5 Bounce / unsubscribe → automatic CRM state changes

Already covered in §11.3 but worth restating as an integration benefit:
- Hard 5xx bounce → email added to `email_blacklist` + matching lead (if any) marked `stage='dead'` with `tags += 'bounced'`
- Inbound reply containing STOP/unsubscribe/remove → blacklist + lead `stage='dead'` with `tags += 'unsubscribed'`

Today this requires manual cleanup — founders see bounce notifications in their inbox and have to act on them. With in-CRM sends, bounce handling and CRM lead state are atomic.

### 12.6 Activity feed integration

The dashboard's existing activity feed (`activity_log` table) already shows lead-level events: stage changes, new replies, etc. With in-CRM sends, we add new event types to the feed:
- `cold_outreach_sent` — "Adit sent 350 cold emails this morning (campaign 4f8…)"
- `cold_outreach_replied` — "Pat at Acme replied to Adit's outreach (variant 'Adit v2')"
- `cold_outreach_bounced` — "3 hard bounces today (auto-blacklisted)"

The aggregate "morning send" event collapses 350 individual sends into one feed row with a click-through to the campaign details. Replies stay individual (those are interesting).

### 12.7 Daily founder digest enrichment

The existing 8am PT daily digest (§11.2) gets a new "Yesterday's outreach" section per founder:

```
Yesterday's cold outreach — Adit
  Sent:           347                       (3 deferred — same-domain dedup)
  Bounced:        4 (1.2%)                  ✅
  Replies so far: 14 (4.0% — 0.4pp above 7-day avg)
  Top variant:    "Adit v2" (8% reply rate, 60% of sends)
  Pool runway:    13 days remaining
```

### 12.8 Schema additions to support §12.1–§12.7

Already covered in the data model, but to make the integration explicit:

```sql
-- On `interactions` (existing table) — link interactions to campaigns and variants
ALTER TABLE interactions
  ADD COLUMN campaign_id          UUID REFERENCES email_send_campaigns(id),
  ADD COLUMN template_variant_id  UUID REFERENCES email_template_variants(id);

CREATE INDEX ON interactions (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX ON interactions (template_variant_id) WHERE template_variant_id IS NOT NULL;

-- On `leads` (existing table) — link leads to the campaign that first created them
ALTER TABLE leads
  ADD COLUMN source_campaign_id   UUID REFERENCES email_send_campaigns(id);

CREATE INDEX ON leads (source_campaign_id) WHERE source_campaign_id IS NOT NULL;

-- New stage value: 'outreach_sent' (sent-but-no-reply-yet)
-- This is a stage BEFORE 'replied' in the pipeline; once they reply,
-- the existing reply pipeline advances them to 'replied' as today.
```

The new `outreach_sent` stage requires updating `STAGE_ORDER` in `src/lib/constants.ts` and adding a UI label "Awaiting Outreach Reply". `replied` already displays as "Awaiting Reply" — `outreach_sent` displays as "Cold Email Sent".

Stage order becomes:
```
outreach_sent → replied → scheduling → scheduled → call_completed → post_call → demo_sent → active_user
                                                                                            ↓
                                                                                paused / dead
```

### 12.9 Future enhancements this design enables (Phase 2+)

The schema/integration above is the *minimum* that makes things observable. Once it ships, several follow-on features become trivial:

- **Cohort funnel analysis** — "Of leads created from cold outreach in May 2026, X% reached `scheduled`, Y% reached `call_completed`, Z% became `active_user`" — single SQL query.
- **Send-time-of-day correlation** — bucket sends by hour, compute reply rate per bucket. Empirically determine optimal send time per recipient timezone.
- **Domain success modeling** — group sends by recipient domain (extracted at send time) — compute per-domain reply rate. Surface "industries that engage" data for founders.
- **AI-personalized opener** — at send time, OpenRouter generates a 1–2 sentence company-specific opener prepended to the variant body. Cost ~$0.001/send. Designed-for in §3 of the spec; just toggled off for v1.
- **Variant retirement / A/B framework** — if a variant has <2% reply rate over 200 sends, auto-disable it and alert the founder. (Statistical-significance gating not required for v1.)
- **Per-recipient send-window override** — if we know a recipient is in EST, send to them at 6am EST instead of 6am PT. Recipient timezone derived from email domain TLD or LinkedIn data.
- **Re-engagement campaigns** — leads in `cold_email_sent` stage for >30 days with no reply: optional second-touch campaign with a different variant.

None of these are in scope for v1. Listing them here so the design is intentional about what it enables, not just what it does.

---

## 13. Phased rollout — 5 PRs

The CRM integration work (§12) is woven into each PR rather than tacked on at the end — every PR's primary outcome is functional, but each one also extends the CRM in some way.

| PR | Effort | Scope | Integration work | Live behavior |
|---|---|---|---|---|
| **PR 1** | 1d | Schema + safety constants | + `interactions.campaign_id`, `interactions.template_variant_id`, `leads.source_campaign_id` columns; add `outreach_sent` stage to `STAGE_ORDER` | Tables exist, no functionality |
| **PR 2** | 3d | Templates UI + variant CRUD + lint + spintax parser | (none — pure UI) | Founders can write/preview templates; nothing sends |
| **PR 3** | 3.5d | Send pipeline + dry-run mode | + Lead auto-create at send via existing `createLeadFromOutreach` helper; + Interaction insert with `campaign_id`/`template_variant_id`; + Bounce/unsubscribe→lead-state side effects | Engine runs in dry-run; debug endpoint sends ONE test email and creates the lead + interaction in CRM |
| **PR 4** | 4d | Cron routes + scheduling + Skip toggle + Priority CSV upload + admin schedule UI | + Activity log entries for campaign events (`cold_outreach_sent`, `cold_outreach_bounced`); + Lead `tags += ['source:cold_outreach', 'campaign:<short_id>']` | Cron infrastructure live; `schedule.enabled = false` default |
| **PR 5** | 3.5d | Health dashboard + alerts + warmup gate + pre-go-live checklist | + Per-variant / per-founder / per-campaign analytics views; + Daily digest "Yesterday's outreach" section; + Activity feed event types | System ready; admin flips `enabled = true` to start Day 1 |

**Total: ~15 working days** (was 14; integration adds ~1 day across PRs 3 and 5).

Each PR is independently testable; pull the plug at any boundary if something looks off.

After PR 5 ships and admin enables:
- Day 1: 250/account = 750 total (smoke test day)
- Day 2+: 350/account = 1,050 total (steady state)
- Day 1 → Day 2 ramp gate: only ramps if Day 1 had no auto-pauses, bounce rate <3%, fewer than 5 hard 5xx errors. Otherwise stays at 250 until two consecutive clean days.

---

## 14. Out-of-band tasks (for the founders, not implementable)

1. **Plus-aliasing Gmail filters** — each founder creates a Gmail filter that catches `to:<their_address>+unsubscribe@berkeley.edu` and labels/archives it appropriately. ~5 minutes per account. Documented in the pre-go-live checklist.

2. **Template content** — founders write 2 actual variants each. I can provide starter templates from existing Gmail patterns; founders edit voice.

3. **Resend "from" address for critical alerts** — confirm an existing or new Resend sender; reuse the `RESEND_API_KEY`.

4. **cron-job.org daily-trigger entry** — created/updated when admin first enables the schedule (URL provided in the schedule UI).

5. **Phase 2: custom outreach domain** — register a domain (e.g. `proxiapp.com`), set up SPF + DKIM (2048-bit) + DMARC (`p=none; rua=` to start), enroll in Postmaster Tools, migrate the `email_template_variants` to use the new `From` address. Separate project after this ships and runs stably for ~30 days.

---

## 15. Open issues / future work

- **Reply rate as deliverability proxy** — relies on prospects actually replying. We assume our pool quality is good; if a campaign has 0 replies in 200 sends, the alert fires but we have no mitigation beyond pause.
- **Manual override of warmup** — admin can skip the warmup day-1 → day-2 ramp gate, but we surface a "warmup skipped" banner. Not enforced.
- **Multi-day skip** — skip-next-run is single-shot. Multi-day skips require pressing the button daily (deliberate forcing function).
- **Concurrent priority uploads** — two admins uploading priority lists simultaneously: the database unique constraint on `(email, scheduled_for_date)` resolves the rare race; first writer wins, second sees a 409.
- **Reply threading** — outbound campaign sends are NEW threads. If a recipient replies, the existing Gmail sync picks up the reply on the founder's account and creates/updates the lead via the standard pipeline. No special handling needed in this design; the matcher (recently broadened) catches both subject styles.

---

## 16. Definitions / glossary

- **Pool**: existing `email_pool` table (~24k cold-outreach rows from CSV)
- **Founder**: a `team_members` row representing one of the 3 co-founders (Adit/Srijay/Asim)
- **Account**: same as founder — one Gmail account per founder
- **Campaign**: one day's full sending operation (1 row in `email_send_campaigns`)
- **Slot**: the scheduled `send_at` timestamp for a queue row
- **Tick**: one execution of `/api/cron/email-tool/tick` (every minute)
- **Variant**: one template option from `email_template_variants`
- **Spintax**: the `{{ RANDOM | a | b }}` syntax for greeting/sign-off variation
- **Drift**: the +15min/day shift in campaign start time
- **Wrap**: when drift would cross 1pm PT, reset to anchor (5:30am) the next day
- **Warmup**: Day 1 = 250/account, Day 2+ = 350/account ramp
- **Priority row**: a row from `email_send_priority_queue` (admin-uploaded, not from pool)
