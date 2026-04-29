# Automated Cold Outreach — Design Spec

**Status:** Approved — ready for implementation planning
**Date:** 2026-04-28
**Owner:** Adit
**Estimated effort:** ~15 working days across 5 PRs, then 1-day soft warmup before steady state

---

## 1. Problem & goals

The 3 founders currently send ~400 cold-outreach emails per Gmail account per day, manually. Each morning one of them logs into Gmail and triggers a YAMM/Mailmeteor merge against a CSV produced by the existing `email-tool`. This is a daily ~30-minute manual chore that is error-prone, easy to skip, and creates a tight coupling between human availability and outbound volume.

**Goal:** replace the manual send step with a fully automated, schedule-driven pipeline that:
- Sends 400 cold-outreach emails per founder per day across all 3 founders' Gmail accounts (1,200/day total), with a 499/day per-account hard ceiling that reserves 99 sends of headroom for the founder's manual sends and CRM auto-replies
- Operates safely within Gmail's per-account daily quotas and per-second rate limits
- Mimics human-pattern sending (jittered timing, content variants, no template fingerprinting) to minimize the chance of accounts being throttled or banned
- Is observable and pause-able the moment something goes wrong
- Supports ad-hoc priority sends (e.g., a hand-curated list of YC partners) without disrupting the regular pool
- **Treats every outbound send as a first-class CRM event** — auto-creates a lead, logs the interaction, attributes the variant + campaign, and produces per-variant / per-founder / per-campaign analytics that founders never had with external tools (see §12)

**Non-goals (deliberately deferred):**
- HTML emails / attachments / inline images
- Open-tracking pixels or click tracking
- A/B testing framework with statistical winner selection
- Custom outreach domain — sending stays on `@berkeley.edu` indefinitely; no domain migration planned
- Postmaster Tools enrollment — requires domain ownership we don't have; we rely on indirect proxies (bounce rate, reply rate, 403 signals)
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
- **3 accounts × 400 automated cold sends/day = 1,200 cold emails/day total**
- Hard per-account ceiling: **499/day** (matches Gmail's free-account safety threshold). The 99-send buffer above the 400 automated target is reserved for the founder's manual sends, auto-replies, and CRM-driven follow-ups that share the same Gmail account.
- Inter-send delay: **random 5–15 seconds per send per account** (avg ~10s) → ~6 sends/min/account
- Send window per account: **400 sends ÷ 6/min ≈ 67 minutes** — campaigns finish well within an hour of starting
- Per-second pace: 0.1 sends/sec/account → 25× under Gmail's 2.5/sec API ceiling
- Daily volume: 400 sent / 2,000 Workspace external cap = **20% of cap** — comfortable headroom

### Bounce-rate threshold rationale
The deliverability industry's "soft" signal threshold is 2% hard bounces, but cold-outreach lists with prospect-discovery sources (Apollo, scraped LinkedIn, etc.) reliably run **3–4% bounces** on quality lists and 5–7% on lower-quality ones. We auto-pause at **5%** rather than 2% specifically because pausing at 2% would constantly trip on normal cold-outreach noise. 5% is the post-Yahoo/Google-2025-update threshold above which deliverability degrades meaningfully.

### What YAMM and Mailmeteor do (the patterns we mirror)
- Send via the user's own Gmail OAuth (not third-party SMTP)
- Pace sends with configurable inter-message delays
- Pause on `insufficient_quota` and resume the next day
- Append `List-Unsubscribe` header to every send
- Include one-click unsubscribe (RFC 8058) for deliverability boost
- Limited spintax for greeting/sign-off variation
- Lint templates against spammy patterns before save

### Postmaster Tools limitation (accepted, not mitigated)
Berkeley owns `berkeley.edu`, not us. We cannot enroll the sending domain in Postmaster Tools, which means we have no direct visibility into spam complaint rate. We accept this limitation and rely on indirect proxies (bounce rate, reply rate, 403 errors). No domain migration is planned — sending stays on `@berkeley.edu` indefinitely.

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
  warmup_day      INT,            -- day 1 = 250/account, day 2+ = 400/account
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

-- 5) Schedule singleton (weekday-only fixed schedule, FK-free)
-- Mon–Fri only, with day-of-week → start-time-PT mapping baked into code.
-- See §5.1 for the exact times. Saturday/Sunday: no campaign runs.
CREATE TABLE email_send_schedule (
  id                    INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  warmup_started_on     DATE,                        -- null until enabled flipped on
  warmup_day_completed  INT NOT NULL DEFAULT 0,      -- gate for Day 1 → Day 2 ramp
  skip_next_run         BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at           TIMESTAMPTZ,
  next_run_at           TIMESTAMPTZ,                 -- denormalized for cron-job.org
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO email_send_schedule (id) VALUES (1) ON CONFLICT DO NOTHING;
-- next_run_at is computed by the application from today's date and the
-- weekday→time map. We store it for display + for cron-job.org's
-- read-back-and-trigger flow, but the source of truth is the code.

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
  // Hard ceiling. The system never schedules more than 499 sends per
  // account per day. The 99-send buffer above the 400 automated target
  // is reserved for the founder's manual sends, auto-replies, and CRM
  // follow-ups that share the same Gmail account.
  ABSOLUTE_DAILY_CAP_PER_ACCOUNT:                 499,
  
  // Steady-state automated cold-outreach target.
  AUTOMATED_DAILY_TARGET_PER_ACCOUNT:             400,
  
  // Day-1 soft warmup cap (smoke-test day before going to full target).
  WARMUP_DAY_1_CAP:                               250,
  
  // Inter-send jitter range — closely mirrors YAMM's pacing model.
  // Random uniform draw within these bounds per send.
  // Avg ~10s → 6 sends/min/account → ~67min per 400-send campaign.
  INTER_SEND_JITTER_MIN_SECONDS:                  5,
  INTER_SEND_JITTER_MAX_SECONDS:                  15,
  
  // Belt-and-suspenders clamp — even if jitter math somehow produces a
  // value outside the jitter range, we never go below this floor.
  MIN_INTER_SEND_GAP_SECONDS_HARD_FLOOR:          5,
  MAX_INTER_SEND_GAP_SECONDS_HARD_CEILING:        30,
  
  // If a campaign would span >2 hours total, abort and alert.
  // At 6/min × 400 sends = ~67 min so this is well-margined.
  MAX_CAMPAIGN_DURATION_HOURS:                    2,
  
  // Same-domain throttle: don't email >1 person at acme.com from one
  // founder same day. Rest go to next day's pool.
  MAX_SENDS_PER_DOMAIN_PER_ACCOUNT_PER_DAY:       1,
  
  // Bounce rate that triggers auto-pause for an account. Set to 5%
  // (not 2%) intentionally — see §2 "Bounce-rate threshold rationale".
  BOUNCE_RATE_PAUSE_THRESHOLD:                    0.05,
  
  // Per-tick processing budget.
  TICK_BUDGET_SENDS_PER_RUN:                      30,
  TICK_BUDGET_DURATION_SECONDS:                   240,
  
  // Stale-row threshold for crash recovery.
  CRASH_RECOVERY_STALE_MINUTES:                   10,
  
  // Priority CSV upload limit per single batch.
  PRIORITY_BATCH_MAX_ROWS_PER_UPLOAD:             500,
  
  // Pool low-water alert threshold (days of runway remaining).
  POOL_LOW_WATER_DAYS:                            5,
} as const;
```

These cannot be changed via UI; they require a code commit + PR review.

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
       - schedule.last_run_at = now()
       - schedule.next_run_at = computeNextRunAt(now())   -- next weekday slot
       - record campaign as 'skipped' (zero queue rows inserted)
       - alert founders: "Today's run skipped at admin request, resuming [next slot]"
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
   • Warmup gate (the Day 1 → steady-state ramp guard):
       prev = most-recent email_send_campaigns row with status IN ('done','exhausted')
       if schedule.warmup_day_completed == 0:
         daily_cap_per_acct = WARMUP_DAY_1_CAP (250)
       else if schedule.warmup_day_completed == 1:
         if prev.bounce_rate < 0.03 AND prev.had_no_auto_pauses AND prev.hard_5xx < 5:
           daily_cap_per_acct = AUTOMATED_DAILY_TARGET_PER_ACCOUNT (400)
         else:
           daily_cap_per_acct = WARMUP_DAY_1_CAP (250)   -- stay until clean
       else:
         daily_cap_per_acct = AUTOMATED_DAILY_TARGET_PER_ACCOUNT (400)
   • Hard ceiling enforcement: daily_cap_per_acct never exceeds
     ABSOLUTE_DAILY_CAP_PER_ACCOUNT (499). The 99-send buffer above 400
     reserves headroom for the founder's personal Gmail activity.
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

⑧ Slot scheduling (per founder, independent jitter — mirrors YAMM's pacing)
   • cursor = campaign_start + random(0, 10s)               -- small initial offset
   • for each send in chunk:
       slot = cursor
       cursor += random(INTER_SEND_JITTER_MIN_SECONDS, INTER_SEND_JITTER_MAX_SECONDS)
       --                                  5s              15s
       cursor = clamp(cursor, MIN_HARD_FLOOR=5s, MAX_HARD_CEILING=30s) per gap
   • Avg gap ≈ 10s → 6 sends/min/account → 400 sends in ~67 min
   • If total span > MAX_CAMPAIGN_DURATION_HOURS (2h) → abort, alert (won't happen at 400)

⑨ Bulk insert into email_send_queue
   • One row per recipient × variant × slot
   • status='pending'

⑩ Priority queue update + schedule advance
   • UPDATE email_send_priority_queue SET status='scheduled', campaign_id=...
   • email_send_schedule.last_run_at = now()
   • email_send_schedule.next_run_at = computeNextRunAt(now())   -- next weekday slot
   • If campaign reached steady-state cap (400) and warmup_day_completed < 2:
       email_send_schedule.warmup_day_completed += 1
   • email_send_campaigns SET status='running', started_at=now()
   • Function returns
```

### 5.1 Weekday-only schedule (fixed times)

No drift, no anchor, no day_index. The schedule is a fixed map from day-of-week to PT start time. Saturday and Sunday have no campaigns.

```typescript
// src/lib/email-tool/schedule.ts
export const WEEKDAY_START_TIMES_PT: Record<number, { hour: number; minute: number }> = {
  1: { hour: 5,  minute:  0 },   // Monday    — 5:00 AM PT
  2: { hour: 5,  minute: 30 },   // Tuesday   — 5:30 AM PT
  3: { hour: 6,  minute:  0 },   // Wednesday — 6:00 AM PT
  4: { hour: 6,  minute: 30 },   // Thursday  — 6:30 AM PT
  5: { hour: 7,  minute:  0 },   // Friday    — 7:00 AM PT
  // 0 = Sunday, 6 = Saturday — no entries → no campaigns
};

export function computeNextRunAt(now: Date = new Date()): Date | null {
  // Walk forward up to 7 days to find the next weekday with an entry.
  for (let i = 0; i < 7; i++) {
    const candidate = addDays(now, i);
    const dow = ptDayOfWeek(candidate);                 // 0..6 in PT
    const slot = WEEKDAY_START_TIMES_PT[dow];
    if (!slot) continue;                                // skip Sat/Sun
    const ptStart = ptDateTime(candidate, slot.hour, slot.minute);
    if (ptStart > now) return ptStart;                  // first future slot
  }
  return null;                                          // shouldn't happen
}
```

Behavior:
- **Monday 5:00 AM PT** — campaign starts (drains 400 sends/account in ~67 min, finishing ~6:07 AM PT)
- **Tuesday 5:30 AM PT** — start (finishes ~6:37 AM PT)
- **Wednesday 6:00 AM PT** — start (finishes ~7:07 AM PT)
- **Thursday 6:30 AM PT** — start (finishes ~7:37 AM PT)
- **Friday 7:00 AM PT** — start (finishes ~8:07 AM PT)
- **Saturday & Sunday** — no campaign

The +30min/day stagger across weekdays gives the time-of-day variation that makes our send pattern look human (not always-the-same-time-each-day). Resetting to 5:00 AM each Monday means the +30min drift never carries past 7 AM PT — staying in the optimal "first thing in the morning" inbox window.

#### After Friday's campaign

`computeNextRunAt()` returns next Monday at 5:00 AM PT. cron-job.org's daily polling sees the new `next_run_at`, doesn't fire on Sat/Sun, and triggers Monday morning.

#### What if Friday's run is missed (server down etc.)?

The next morning's cron poll (Saturday) sees `next_run_at` is in the past. We don't backfill. The cron does an idempotent re-check, sees we're now on Saturday (no slot), and bumps `next_run_at` to next Monday 5:00 AM. Friday's slot is forfeited.

#### Holidays / one-off skips

The "Skip One Day" toggle (§9) handles ad-hoc skips. If you hit it on Sunday night, Monday's campaign is skipped and Tuesday's runs at its normal time. No drift accumulation because there's no drift.

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

### 7.3 Merge tags — the per-recipient personalization model

Two recipient variables are the **primary** personalization mechanism — these are the same `{{first_name}}` / `{{company}}` tokens YAMM uses, so the muscle memory transfers exactly:

| Tag | Source | Fallback if blank | Notes |
|---|---|---|---|
| `{{first_name}}` | `email_pool.first_name` (or priority CSV column) | `there` | Most-used tag — every greeting should reference this |
| `{{company}}` | `email_pool.company` (or priority CSV column) | `your company` | Used in subject and/or body opener |
| `{{founder_name}}` | live read from sending founder's `team_members.name` | (always set) | Auto-populated, founder doesn't manage |

**Authoring example:**

```
Subject: product prioritization at {{company}}

{{ RANDOM | Hi | Hey }} {{first_name}},

I'm a Berkeley CS student exploring how teams at {{company}} decide what
product work to prioritize when there are competing user, analytics, and
internal signals.

Would love 10–15 minutes if you're open to it.

{{ RANDOM | Cheers | Thanks | Best }},
{{founder_name}}
```

When sent to `pat@acme.com` with `first_name=Pat`, `company=Acme`, `founder_name=Adit`:

```
Subject: product prioritization at Acme

Hey Pat,

I'm a Berkeley CS student exploring how teams at Acme decide what product
work to prioritize when there are competing user, analytics, and internal
signals.

Would love 10–15 minutes if you're open to it.

Cheers,
Adit
```

**The two recipient tags `{{first_name}}` and `{{company}}` are first-class:**
- The templates UI treats them as known tokens — autocomplete in the editor, syntax-highlighted in the live preview
- The lint warns (Section 7.5) if a body lacks BOTH (no personalization at all)
- The CSV upload page for priority lists (Section 10) explicitly requires `email`, `first_name`, `company` columns
- The pool picker (`email_pool` table, existing) already has these columns populated

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

Lives as the **Templates** tab on the consolidated admin page at `/email-tool/admin?tab=templates`. See **Section 11.4** for the full UI design including the per-variant edit modal with autocomplete for `{{first_name}}`/`{{company}}`/`{{founder_name}}`, live preview with sample data, and inline lint feedback.

---

## 8. Reply detection (two-layer)

### Layer 1: Pre-pick filter (at `/start` step ④)
For each candidate pool row, check if `recipient_email` matches any CRM lead with an inbound interaction in the last 90 days. If yes, silently skip (treat as already-blacklisted). Catches the case where someone replied via a different thread / different lead-creation path that the standard blacklist missed.

### Layer 2: Pre-send check (at tick step ④a)
Right before sending, query: has this `recipient_email` sent us anything in the last 4h? If yes, skip with `status='skipped', last_error='replied_during_campaign'`. Catches the race where someone replies to a 5:30am send (delivered to founder A's inbox) before founder B's slot to the same recipient hits at 7:30am.

Cost: 1 indexed query per send (cheap).

---

## 9. Skip One Day toggle

UI: `⏭ Skip Next Run` button in the consolidated admin page header (always visible — see §11.4).

Click flow:
- POST to `/api/cron/email-tool/schedule/skip` (admin-gated)
- Sets `email_send_schedule.skip_next_run = true`
- UI shows banner: "Tomorrow's automated send will be skipped. The schedule resumes [day after]."
- Banner has Undo link until midnight tonight (clears the flag)

Behavior:
- Single-shot — skipping repeatedly requires repeated clicks
- Slot is forfeited (no backfill); `next_run_at` advances to the *next* weekday slot
- Founders alerted via Resend that the day was skipped

---

## 10. Priority CSV Override

### 10.1 Upload UI

Triggered from the `➕ Upload Priority Batch` button (always visible in the consolidated admin page header — see §11.4) OR from the **Priority Queue** tab. Upload opens as a modal so the admin doesn't navigate away.

Admin-only.

Inputs:
- Schedule for: dropdown of next 7 weekdays (Sat/Sun excluded), default = next campaign date (with actual time shown per the weekday schedule)
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

Lives as the **Overview** tab on the consolidated admin page (`/email-tool/admin`). See §11.4 for the full layout. Per-founder card:

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

### 11.4 Consolidated admin UI

All admin functionality lives on a single page: **`/email-tool/admin`** (admin-only — same gate as the existing email-tool admin section).

The page has a **persistent header** with 3 primary action buttons (always visible regardless of which tab is active), then a tabbed body for configuration and observation.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Cold Outreach Automation                                  schedule:    │
│                                                            ✅ ENABLED   │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────────┐  │
│  │ 🛑 Pause All Sending │  │ ⏭ Skip Next Run    │  │ ➕ Upload Batch │  │
│  └─────────────────────┘  └─────────────────────┘  └────────────────┘  │
├─────────────────────────────────────────────────────────────────────────┤
│  [ Overview ]  [ Templates ]  [ Schedule ]  [ Priority Queue ]          │
├─────────────────────────────────────────────────────────────────────────┤
│  (tab content here)                                                     │
└─────────────────────────────────────────────────────────────────────────┘
```

#### The 3 primary action buttons

1. **🛑 Pause All Sending** (red, prominent)
   - Confirmation dialog: "Pause cold outreach for all 3 founders? In-flight sends will complete; no new sends until you resume."
   - On confirm: `UPDATE team_members SET email_send_paused=true, email_send_paused_reason='admin_pause', email_send_paused_at=now()`
   - Header status changes to `🛑 ALL PAUSED — [Resume All]`
   - The button itself becomes `▶️ Resume All Sending`
   - Touch each founder individually for selective pause (Templates tab → per-founder controls)

2. **⏭ Skip Next Run** (gray)
   - Click immediately sets `email_send_schedule.skip_next_run = true` (no confirmation — easy to undo)
   - Header shows banner: "Tomorrow's run (Tuesday 5:30 AM PT) will be skipped. [Undo]"
   - Single-shot — re-press for additional skips
   - Disabled (grayed out) if `enabled=false` or already-skipping

3. **➕ Upload Priority Batch** (blue, primary action)
   - Opens a modal directly (doesn't navigate)
   - Modal has the upload UI from §10 (CSV upload OR paste-emails)
   - Validation step + lead-owner attribution UI inline
   - Confirmation submits and closes; toast: "Scheduled 47 priority emails for tomorrow's run"

#### Tab 1 — Overview (default)

Per-founder health cards (the dashboard from §11.1) plus aggregate row showing pool runway, today's totals. This is the "is everything healthy?" landing page.

#### Tab 2 — Templates

Per-founder template library:

```
┌─ Adit Mittal ─────────────────────  [+ New Variant]  [Pause Adit only]┐
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │ ✓ Adit v1                            Sent 1,247 · Reply 5.2% ✏  │ │
│  │   Subject: product prioritization at {{company}}                  │ │
│  │   "Hi {{first_name}}, I'm a Berkeley CS student exploring..."    │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │ ✓ Adit v2                            Sent  893 · Reply 8.1% ✏  │ │
│  │   Subject: how does {{company}} prioritize product work?         │ │
│  │   ...                                                            │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘

[Srijay Vejendla section ...]
[Asim Ali section ...]
```

Edit modal (per variant):

```
┌─ Edit variant: Adit v2 ────────────────────────────────────────────┐
│                                                                    │
│  Label:    [ Adit v2                                            ]  │
│                                                                    │
│  Subject:  [ how does {{company}} prioritize product work?      ]  │
│            ✓ uses {{company}}                                      │
│                                                                    │
│  Body:                                                             │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ {{ RANDOM | Hi | Hey }} {{first_name}},                      │  │
│  │                                                               │  │
│  │ I'm a Berkeley CS student exploring how teams at             │  │
│  │ {{company}} decide what product work to prioritize when      │  │
│  │ there are competing user, analytics, and internal signals.   │  │
│  │                                                               │  │
│  │ Would love 10–15 minutes if you're open to it.               │  │
│  │                                                               │  │
│  │ {{ RANDOM | Cheers | Thanks | Best }},                       │  │
│  │ {{founder_name}}                                             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Variables available:  {{first_name}}  {{company}}  {{founder_name}}│
│                                                                    │
│  ─────────────  Live Preview (with sample data) ───────────────    │
│                                                                    │
│  Subject: how does Acme prioritize product work?                   │
│                                                                    │
│  Hey Pat,                                                          │
│                                                                    │
│  I'm a Berkeley CS student exploring how teams at Acme decide      │
│  what product work to prioritize when there are competing user,    │
│  analytics, and internal signals.                                  │
│                                                                    │
│  Would love 10–15 minutes if you're open to it.                    │
│                                                                    │
│  Cheers,                                                           │
│  Adit                                                              │
│                                                                    │
│  [Re-roll spintax preview]                                         │
│                                                                    │
│  ─────────────  Lint  ──────────────────────────────────────────   │
│  ✅ No blockers                                                    │
│  ⚠ 1 warning: subject 60/80 chars                                  │
│                                                                    │
│  [ Cancel ]                            [ Save ]   [ Save & Activate]│
└────────────────────────────────────────────────────────────────────┘
```

Live preview re-renders on every keystroke. The "Variables available" row shows clickable chips that insert the tag at the cursor position.

#### Tab 3 — Schedule

```
┌─ Schedule ─────────────────────────────────────────────────────────┐
│                                                                    │
│  Master toggle:  [ Enabled ⏵ ]    (default off; admin flips on)   │
│                                                                    │
│  Weekly schedule (PT):                                             │
│    Monday      5:00 AM      ─ 400 sends/account ─ ~6:07 AM         │
│    Tuesday     5:30 AM      ─ 400 sends/account ─ ~6:37 AM         │
│    Wednesday   6:00 AM      ─ 400 sends/account ─ ~7:07 AM         │
│    Thursday    6:30 AM      ─ 400 sends/account ─ ~7:37 AM         │
│    Friday      7:00 AM      ─ 400 sends/account ─ ~8:07 AM         │
│    Saturday    — no campaign —                                     │
│    Sunday      — no campaign —                                     │
│                                                                    │
│  Next run:    Mon, May 4 — 5:00 AM PT (in 3d 7h)                  │
│  Last run:    Fri, May 1 — 7:00 AM PT (1,047 sent, 41 replies)    │
│                                                                    │
│  Warmup status:  Day 2+ steady state (400/account)                 │
│                                                                    │
│  [ Skip next run ]      (same as the header button)                │
│                                                                    │
│  Recent runs:                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Date     Started   Sent   Bounced   Replies   Status         │  │
│  │ May 1   7:00 AM   1,047   12 (1.1%)   41      ✅ done        │  │
│  │ Apr 30  6:30 AM   1,043    9 (0.9%)   38      ✅ done        │  │
│  │ Apr 29  6:00 AM   1,051   15 (1.4%)   29      ✅ done        │  │
│  │ ...                                                          │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

The weekly schedule grid is read-only — the times are hardcoded per §5.1 and only change with a code commit. Editable controls are: master toggle, skip-next, and warmup-skip override (admin button with a "this is a bad idea" banner).

#### Tab 4 — Priority Queue

```
┌─ Priority Queue ──────────────────────────────────────────────────┐
│                                                                   │
│  [➕ Upload new batch]   (same as the header button)              │
│                                                                   │
│  Scheduled for tomorrow (Tue, May 5 — 5:30 AM PT):                │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ "YC partner contacts" — 47 emails — uploaded by Adit 4:12pm │  │
│  │ Owner attribution: Use lead owners (8 Adit, 3 Srijay, 1 Asim)│ │
│  │ [ Show full list ▾ ]                          [ Cancel batch]│ │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  Sent / completed batches (last 30d):                             │
│    May 1  "Demo follow-ups"  23 emails  → 5 replies (21.7%)       │
│    Apr 27 "YC W26 cohort"    35 emails  → 12 replies (34.3%)      │
│    ...                                                            │
└───────────────────────────────────────────────────────────────────┘
```

#### Routing summary (the change from earlier sections)

The earlier sections referenced `/email-tool/admin/templates`, `/email-tool/admin/schedule`, `/email-tool/admin/priority`, `/email-tool/admin/health` as separate pages. **We consolidate to a single page** at `/email-tool/admin` with the 4 tabs above. Tabs are URL-routed (`?tab=templates`) so links from alerts work.

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
- "Last campaign: 400 sent, 32 replied (8% — 2pp above 30-day average)"

Founders get the iteration data they've never had before. Variants that consistently underperform get retired; high-performers get cloned and tweaked.

### 12.5 Bounce / unsubscribe → automatic CRM state changes

Already covered in §11.3 but worth restating as an integration benefit:
- Hard 5xx bounce → email added to `email_blacklist` + matching lead (if any) marked `stage='dead'` with `tags += 'bounced'`
- Inbound reply containing STOP/unsubscribe/remove → blacklist + lead `stage='dead'` with `tags += 'unsubscribed'`

Today this requires manual cleanup — founders see bounce notifications in their inbox and have to act on them. With in-CRM sends, bounce handling and CRM lead state are atomic.

### 12.6 Activity feed integration

The dashboard's existing activity feed (`activity_log` table) already shows lead-level events: stage changes, new replies, etc. With in-CRM sends, we add new event types to the feed:
- `cold_outreach_sent` — "Adit sent 400 cold emails this morning (campaign 4f8…)"
- `cold_outreach_replied` — "Pat at Acme replied to Adit's outreach (variant 'Adit v2')"
- `cold_outreach_bounced` — "3 hard bounces today (auto-blacklisted)"

The aggregate "morning send" event collapses 400 individual sends into one feed row with a click-through to the campaign details. Replies stay individual (those are interesting).

### 12.7 Daily founder digest enrichment

The existing 8am PT daily digest (§11.2) gets a new "Yesterday's outreach" section per founder:

```
Yesterday's cold outreach — Adit
  Sent:           397                       (3 deferred — same-domain dedup)
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
- Day 2+: 400/account = 1,200 total (steady state)
- Day 1 → Day 2 ramp gate: only ramps if Day 1 had no auto-pauses, bounce rate <3%, fewer than 5 hard 5xx errors. Otherwise stays at 250 until two consecutive clean days.

---

## 14. Out-of-band tasks (for the founders, not implementable)

1. **Plus-aliasing Gmail filters** — each founder creates a Gmail filter that catches `to:<their_address>+unsubscribe@berkeley.edu` and labels/archives it appropriately. ~5 minutes per account. Documented in the pre-go-live checklist.

2. **Template content** — founders write 2 actual variants each. I'll provide starter templates from existing Gmail patterns ("Berkeley student interested in product prioritization at..."); founders edit voice/length to taste.

3. **Resend "from" address for critical alerts** — confirm an existing or new Resend sender; reuse the `RESEND_API_KEY`.

4. **cron-job.org daily-trigger entry** — created/updated when admin first enables the schedule (URL provided in the schedule UI).

### Auth confirmation — Gmail OAuth tokens already in place

All 3 founders' Gmail accounts already have OAuth tokens with the necessary scopes (`gmail.readonly`, `gmail.send`, `gmail.modify`) — they were established as part of the existing Gmail integration (see `src/lib/gmail/auth.ts` + the existing `/api/gmail/connect` flow). The tokens auto-refresh in `src/lib/gmail/client.ts`. **No additional auth/OAuth setup is needed for this build.** The send pipeline reuses `getGmailClientForMember()` which is the same client the existing reply-sender already uses.

If a founder's token is revoked at any point, the existing `gmail_connected` flag flips to false — the send pipeline detects this and pauses that account with `paused_reason='oauth_revoked'`. The founder reconnects via `/settings`, and admin manually resumes.

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
- **Weekday schedule**: fixed map from day-of-week to PT start time (Mon 5:00, Tue 5:30, Wed 6:00, Thu 6:30, Fri 7:00). Sat/Sun: no campaigns
- **Warmup**: Day 1 = 250/account, Day 2+ = 400/account ramp (gated by Day-1 cleanliness check)
- **Priority row**: a row from `email_send_priority_queue` (admin-uploaded, not from pool)
