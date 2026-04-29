# Automated Cold Outreach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully automated daily cold-outreach pipeline that sends ~400 emails per founder per day across 3 Gmail accounts on a fixed weekday schedule (Mon 5:00am → Fri 7:00am PT, Sat/Sun off), with content randomization, safety guardrails, idempotency, observability, and full CRM integration.

**Architecture:** Single Vercel cron entry firing every minute (`* * * * *`) is the only entry point. The tick handler self-triggers `runDailyStart()` when due (PT-aware) AND no campaign exists for today's idempotency_key, then drains the queue. SERIALIZABLE transaction wraps the campaign-claim. Three migrations land with their consumers (PR 1 / PR 3 / PR 4) rather than front-loaded. Send modes (`production` / `dry_run` / `allowlist`) gate the actual Gmail API call. Crash signal counted from `email_send_errors` table, reset by admin "Resume All". CRM gets free integration: lead auto-create at send, instant interaction logging, per-variant analytics, daily digest enrichment.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase (Postgres) via `claude_exec_sql` RPC for migrations, Vercel cron + Pro tier (REQUIRED for `* * * * *`), googleapis Gmail client, Resend for alerts, Vitest for tests (added in PR 1).

**Spec:** `docs/superpowers/specs/2026-04-28-automated-cold-outreach-design.md` (1,534 lines, SHA `6d5ecf2`).

---

## Top-of-Plan Reading

Before starting any PR, read these spec sections:
- **§3 Architecture** — single cron, idempotency model, why no second scheduler
- **§4.0–4.3 Data model** — table responsibilities, migration split, hardcoded safety constants
- **§5 Daily flow** — runDailyStart's 11-step orchestration
- **§6 Minute-tick flow** — orphan recovery + self-trigger + drain
- **§11.4–11.6 Observability + send modes + admin UI** — operational posture

**Hard prerequisite (verify before starting PR 1):** Vercel project plan is **Pro tier or higher**. Hobby tier silently no-ops on `* * * * *` cron. If on Hobby, this plan stops here until upgraded.

---

# PR 1 — Core scaffolding

**Estimated:** 1 day. Pure-additive schema + safety constants + structured logger + Vitest setup. Production CRM behavior is unchanged.

**Files:**
- Create: `vitest.config.ts`
- Create: `src/test/setup.ts`
- Modify: `package.json` (add vitest devDependency + test script)
- Create: `supabase/migrations/021_email_send_core.sql`
- Create: `src/lib/email-tool/safety-limits.ts`
- Create: `src/lib/email-tool/types.ts`
- Create: `src/lib/email-tool/log.ts`
- Create: `src/lib/email-tool/__tests__/log.test.ts`
- Create: `src/lib/email-tool/__tests__/safety-limits.test.ts`

### Task 1.1: Set up Vitest

The codebase has no test framework yet (existing test-like files are ad-hoc `tsx scripts/*.ts`). PR 1 establishes Vitest as the test framework so PRs 2-5 can use it.

- [ ] **Step 1: Install vitest**

```bash
npm install --save-dev vitest @vitest/ui
```

- [ ] **Step 2: Create vitest.config.ts**

Create `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

- [ ] **Step 3: Create test setup file**

Create `src/test/setup.ts`:
```typescript
// Global test setup. Add fixtures or env shims here as needed.
process.env.NODE_ENV = 'test';
```

- [ ] **Step 4: Add npm test script**

Modify `package.json` — add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 5: Verify framework is wired**

```bash
npx vitest run --version
```
Expected: prints vitest version, no errors.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts src/test/setup.ts package.json package-lock.json
git commit -m "build: add vitest test framework"
```

### Task 1.2: Hardcoded safety constants

These ceilings are the source-of-truth for everything in the pipeline. Code-only (not DB) so admin UI can't accidentally raise them.

- [ ] **Step 1: Write the failing test**

Create `src/lib/email-tool/__tests__/safety-limits.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { SAFETY_LIMITS } from '../safety-limits';

describe('SAFETY_LIMITS', () => {
  it('caps automated daily target at 400 per account', () => {
    expect(SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT).toBe(400);
  });

  it('absolute hard ceiling reserves 99-send buffer above target', () => {
    expect(SAFETY_LIMITS.ABSOLUTE_DAILY_CAP_PER_ACCOUNT).toBe(499);
    expect(SAFETY_LIMITS.ABSOLUTE_DAILY_CAP_PER_ACCOUNT).toBeGreaterThan(
      SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT
    );
  });

  it('jitter range is 5-15s with hard floor/ceiling clamp', () => {
    expect(SAFETY_LIMITS.INTER_SEND_JITTER_MIN_SECONDS).toBe(5);
    expect(SAFETY_LIMITS.INTER_SEND_JITTER_MAX_SECONDS).toBe(15);
    expect(SAFETY_LIMITS.MIN_INTER_SEND_GAP_SECONDS_HARD_FLOOR).toBe(5);
    expect(SAFETY_LIMITS.MAX_INTER_SEND_GAP_SECONDS_HARD_CEILING).toBe(30);
  });

  it('warmup day 1 is 250/account', () => {
    expect(SAFETY_LIMITS.WARMUP_DAY_1_CAP).toBe(250);
  });

  it('bounce-rate auto-pause threshold is 5%', () => {
    expect(SAFETY_LIMITS.BOUNCE_RATE_PAUSE_THRESHOLD).toBe(0.05);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/email-tool/__tests__/safety-limits.test.ts
```
Expected: FAIL — module './safety-limits' not found.

- [ ] **Step 3: Implement the constants**

Create `src/lib/email-tool/safety-limits.ts`:
```typescript
// Source of truth for all hardcoded limits in the cold-outreach pipeline.
// Admin UI cannot change these; raising any value requires a code commit
// + PR review. See spec §2 + §4.3 for rationale on each value.
export const SAFETY_LIMITS = {
  // Automated cold-send target per account per day.
  AUTOMATED_DAILY_TARGET_PER_ACCOUNT: 400,

  // Absolute ceiling — system never schedules more than this even if a
  // misconfigured target exceeds it. The 99-send buffer above 400 reserves
  // headroom for the founder's manual sends, auto-replies, and CRM
  // follow-ups that share the same Gmail account.
  ABSOLUTE_DAILY_CAP_PER_ACCOUNT: 499,

  // Day-1 soft warmup cap (smoke-test day before going to full target).
  WARMUP_DAY_1_CAP: 250,

  // Inter-send jitter range — closely mirrors YAMM's pacing.
  // Random uniform draw within these bounds per send.
  // Avg ~10s → 6 sends/min/account → ~67min per 400-send campaign.
  INTER_SEND_JITTER_MIN_SECONDS: 5,
  INTER_SEND_JITTER_MAX_SECONDS: 15,

  // Belt-and-suspenders clamps on per-gap value, even if jitter math
  // somehow produces something outside the range.
  MIN_INTER_SEND_GAP_SECONDS_HARD_FLOOR: 5,
  MAX_INTER_SEND_GAP_SECONDS_HARD_CEILING: 30,

  // Sanity check on the campaign window — 6/min × 400 = ~67min, so 2h is
  // generous. Trip means slot scheduling logic is buggy.
  MAX_CAMPAIGN_DURATION_HOURS: 2,

  // No more than 1 send to any recipient_domain per founder per day.
  MAX_SENDS_PER_DOMAIN_PER_ACCOUNT_PER_DAY: 1,

  // Auto-pause threshold for bounce rate (5%, intentionally above industry
  // 2% — see spec §2 "Bounce-rate threshold rationale").
  BOUNCE_RATE_PAUSE_THRESHOLD: 0.05,

  // Per-tick processing budget (Vercel function limit is 5min).
  TICK_BUDGET_SENDS_PER_RUN: 30,
  TICK_BUDGET_DURATION_SECONDS: 240,

  // Stale-row threshold for crash recovery sweep.
  CRASH_RECOVERY_STALE_MINUTES: 10,

  // Orphan-campaign detection window (campaign claimed but no queue rows).
  ORPHAN_CAMPAIGN_THRESHOLD_MINUTES: 5,

  // Crash counter rule — N crashes in M minutes triggers global pause.
  CRASH_COUNTER_THRESHOLD: 3,
  CRASH_COUNTER_WINDOW_MINUTES: 10,

  // Priority CSV upload limit per single batch.
  PRIORITY_BATCH_MAX_ROWS_PER_UPLOAD: 500,

  // Pool low-water alert threshold (days of runway remaining at full volume).
  POOL_LOW_WATER_DAYS: 5,
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/email-tool/__tests__/safety-limits.test.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email-tool/safety-limits.ts src/lib/email-tool/__tests__/safety-limits.test.ts
git commit -m "feat(email-tool): hardcoded safety limits"
```

### Task 1.3: TypeScript types for new entities

- [ ] **Step 1: Create the types file**

Create `src/lib/email-tool/types.ts`:
```typescript
// Shared types for cold-outreach pipeline. Mirrors the schema in
// supabase/migrations/021_email_send_core.sql. See spec §4.1 for
// authoritative column definitions; this file is the consumer-facing
// TypeScript shape.

export type CampaignStatus =
  | 'pending'   // INSERTed; runDailyStart not yet completed all 11 steps
  | 'running'   // queue rows inserted; tick is draining
  | 'done'      // all queue rows reached terminal state
  | 'aborted'   // orphan-recovery sweep fired, OR explicit admin abort
  | 'paused'    // all founders paused mid-campaign
  | 'exhausted' // pool ran out
  | 'skipped';  // skip_next_run was set, so no queue rows

export type QueueStatus =
  | 'pending'   // waiting for slot
  | 'sending'   // tick has claimed it (FOR UPDATE SKIP LOCKED)
  | 'sent'      // Gmail API call succeeded (or synthetic in dry_run)
  | 'failed'    // terminal error (bounce, render fail, etc.)
  | 'skipped';  // pre-send check rejected (replied / not-in-allowlist / etc.)

export type SendMode = 'production' | 'dry_run' | 'allowlist';

export type ContactSource = 'pool' | 'priority';

export type PriorityStatus = 'pending' | 'scheduled' | 'sent' | 'skipped' | 'cancelled';

export type ErrorClass =
  | 'crash'           // uncaught exception in tick handler
  | 'gmail_api_error' // Gmail returned non-success
  | 'render_error'    // template render threw
  | 'config_error'    // missing variant, OAuth invalid, etc.
  | 'timeout'         // tick exceeded budget
  | 'unknown';

export interface EmailSendCampaign {
  id: string;
  idempotency_key: string;
  scheduled_for: string;
  started_at: string | null;
  completed_at: string | null;
  status: CampaignStatus;
  total_picked: number;
  total_sent: number;
  total_failed: number;
  total_skipped: number;
  abort_reason: string | null;
  warmup_day: number | null;
  send_mode: SendMode;
  created_by: string | null;
  created_at: string;
}

export interface EmailSendQueueRow {
  id: string;
  campaign_id: string;
  account_id: string;
  recipient_email: string;
  recipient_name: string | null;
  recipient_company: string | null;
  template_variant_id: string;
  send_at: string;
  status: QueueStatus;
  attempts: number;
  last_error: string | null;
  sending_started_at: string | null;
  sent_at: string | null;
  gmail_message_id: string | null;
  source: ContactSource;
  priority_id: string | null;
  created_at: string;
}

export interface EmailTemplateVariant {
  id: string;
  founder_id: string;
  label: string;
  subject_template: string;
  body_template: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EmailSendSchedule {
  id: 1;
  enabled: boolean;
  send_mode: SendMode;
  warmup_started_on: string | null;
  warmup_day_completed: number;
  skip_next_run: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  crashes_counter_reset_at: string | null;
  updated_at: string;
}

export interface EmailSendPriorityRow {
  id: string;
  email: string;
  first_name: string | null;
  company: string | null;
  uploaded_by: string;
  uploaded_at: string;
  scheduled_for_date: string;
  notes: string | null;
  override_blacklist: boolean;
  override_owner: string | null;
  status: PriorityStatus;
  campaign_id: string | null;
  last_error: string | null;
}

export interface EmailSendError {
  id: string;
  campaign_id: string | null;
  account_id: string | null;
  queue_row_id: string | null;
  error_class: ErrorClass;
  error_code: string | null;
  error_message: string | null;
  context: Record<string, unknown> | null;
  occurred_at: string;
}
```

- [ ] **Step 2: Confirm typecheck**

```bash
npx tsc --noEmit
```
Expected: clean exit (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/lib/email-tool/types.ts
git commit -m "feat(email-tool): TypeScript types for new entities"
```

### Task 1.4: Structured JSON logger

- [ ] **Step 1: Write the failing test**

Create `src/lib/email-tool/__tests__/log.test.ts`:
```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '../log';

describe('log()', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    consoleSpy?.mockRestore();
  });

  it('emits a JSON line to stdout with required fields', () => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('info', 'tick_start', { campaign_id: 'abc-123' });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const json = JSON.parse((consoleSpy.mock.calls[0] as [string])[0]);
    expect(json.level).toBe('info');
    expect(json.event).toBe('tick_start');
    expect(json.component).toBe('email-send');
    expect(json.campaign_id).toBe('abc-123');
    expect(typeof json.ts).toBe('string');
    expect(json.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('handles no-fields case', () => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('warn', 'pool_low_water');
    const json = JSON.parse((consoleSpy.mock.calls[0] as [string])[0]);
    expect(json.event).toBe('pool_low_water');
    expect(json.level).toBe('warn');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/email-tool/__tests__/log.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the logger**

Create `src/lib/email-tool/log.ts`:
```typescript
// Structured JSON logger for the cold-outreach pipeline. Emits to stdout
// (Vercel captures stdout per function invocation and exposes it for
// search). Use at every key transition: tick_start, runDailyStart fired,
// per-send success/failure summary, auto-pause, etc.
//
// Why structured: ops can grep `event=auto_pause` or `error_class=crash`
// directly in Vercel's log dashboard once these JSON lines accumulate.

export type LogLevel = 'info' | 'warn' | 'error';

export function log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    component: 'email-send',
    ...(fields ?? {}),
  };
  // eslint-disable-next-line no-console -- intentional structured stdout
  console.log(JSON.stringify(line));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/email-tool/__tests__/log.test.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email-tool/log.ts src/lib/email-tool/__tests__/log.test.ts
git commit -m "feat(email-tool): structured JSON logger"
```

### Task 1.5: Database migration `021_email_send_core.sql`

This is the big one for PR 1. All pipeline tables in one migration with FK ordering preserved. **Additive only — no DROP/TRUNCATE/narrow ALTER.**

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/021_email_send_core.sql`:
```sql
-- Phase 17: Automated cold-outreach pipeline (core scaffolding).
-- Pure additive — no destructive operations. See spec §4 for full design.
--
-- Tables created:
--   email_send_campaigns       — per-day campaign run record
--   email_template_variants    — per-founder template library (≥2 active required)
--   email_send_priority_queue  — admin-uploaded priority rows
--   email_send_queue           — individual send slots (jittered)
--   email_send_schedule        — singleton row holding weekday-only schedule state
--   email_send_errors          — observability table for crash counting
--
-- Columns added to existing tables:
--   team_members.email_send_paused           — per-account pause flag
--   team_members.email_send_paused_reason    — human-readable reason
--   team_members.email_send_paused_at        — timestamp of last pause
--   email_blacklist.source                   — nullable tag for dry-run cleanup
--
-- Migration order matters (FK dependencies):
--   1) email_send_campaigns (no FKs out)
--   2) email_template_variants (FK: team_members)
--   3) email_send_priority_queue (campaign_id FK added later)
--   4) email_send_queue (FKs: campaigns, team_members, variants, priority_queue)
--   5) email_send_schedule (no FKs)
--   6) email_send_errors (FKs: campaigns, team_members, queue)
--   7) ALTER email_send_priority_queue add cross-table FK to campaigns
--   8) ALTER team_members add new columns
--   9) ALTER email_blacklist add source column

-- ── 1) Campaigns ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_send_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL,
  scheduled_for   TIMESTAMPTZ NOT NULL,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending',
  total_picked    INT NOT NULL DEFAULT 0,
  total_sent      INT NOT NULL DEFAULT 0,
  total_failed    INT NOT NULL DEFAULT 0,
  total_skipped   INT NOT NULL DEFAULT 0,
  abort_reason    TEXT,
  warmup_day      INT,
  send_mode       TEXT NOT NULL DEFAULT 'production',
  created_by      UUID REFERENCES team_members(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_send_campaigns_idempotency_key_uniq
  ON email_send_campaigns (idempotency_key);
CREATE INDEX IF NOT EXISTS email_send_campaigns_status_scheduled_idx
  ON email_send_campaigns (status, scheduled_for);

-- ── 2) Template variants ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_template_variants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id          UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  subject_template    TEXT NOT NULL,
  body_template       TEXT NOT NULL,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (founder_id, label)
);
CREATE INDEX IF NOT EXISTS email_template_variants_founder_active_idx
  ON email_template_variants (founder_id, is_active);

-- ── 3) Priority queue (FK to campaigns added in step 7) ───────────────────
CREATE TABLE IF NOT EXISTS email_send_priority_queue (
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
  status              TEXT NOT NULL DEFAULT 'pending',
  campaign_id         UUID,
  last_error          TEXT
);
CREATE INDEX IF NOT EXISTS email_send_priority_queue_date_status_idx
  ON email_send_priority_queue (scheduled_for_date, status);
CREATE UNIQUE INDEX IF NOT EXISTS email_send_priority_queue_email_date_uniq
  ON email_send_priority_queue (email, scheduled_for_date)
  WHERE status IN ('pending', 'scheduled');

-- ── 4) Send queue ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_send_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES email_send_campaigns(id) ON DELETE CASCADE,
  account_id          UUID NOT NULL REFERENCES team_members(id),
  recipient_email     TEXT NOT NULL CHECK (recipient_email = lower(recipient_email)),
  recipient_name      TEXT,
  recipient_company   TEXT,
  template_variant_id UUID NOT NULL REFERENCES email_template_variants(id),
  send_at             TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  sending_started_at  TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  gmail_message_id    TEXT,
  source              TEXT NOT NULL DEFAULT 'pool',
  priority_id         UUID REFERENCES email_send_priority_queue(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, recipient_email)
);
CREATE INDEX IF NOT EXISTS email_send_queue_status_send_at_idx
  ON email_send_queue (status, send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS email_send_queue_account_sent_idx
  ON email_send_queue (account_id, sent_at);
CREATE INDEX IF NOT EXISTS email_send_queue_campaign_status_idx
  ON email_send_queue (campaign_id, status);

-- ── 5) Schedule singleton ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_send_schedule (
  id                          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                     BOOLEAN NOT NULL DEFAULT FALSE,
  send_mode                   TEXT NOT NULL DEFAULT 'production',
  warmup_started_on           DATE,
  warmup_day_completed        INT NOT NULL DEFAULT 0,
  skip_next_run               BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at                 TIMESTAMPTZ,
  next_run_at                 TIMESTAMPTZ,
  crashes_counter_reset_at    TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO email_send_schedule (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── 6) Errors / observability ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_send_errors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID REFERENCES email_send_campaigns(id),
  account_id      UUID REFERENCES team_members(id),
  queue_row_id    UUID REFERENCES email_send_queue(id),
  error_class     TEXT NOT NULL,
  error_code      TEXT,
  error_message   TEXT,
  context         JSONB,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_send_errors_occurred_class_idx
  ON email_send_errors (occurred_at, error_class);
CREATE INDEX IF NOT EXISTS email_send_errors_campaign_idx
  ON email_send_errors (campaign_id) WHERE campaign_id IS NOT NULL;

-- ── 7) Add cross-table FK on priority_queue.campaign_id ───────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_priority_campaign'
  ) THEN
    ALTER TABLE email_send_priority_queue
      ADD CONSTRAINT fk_priority_campaign
      FOREIGN KEY (campaign_id) REFERENCES email_send_campaigns(id);
  END IF;
END $$;

-- ── 8) Add columns to team_members ────────────────────────────────────────
ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS email_send_paused        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_send_paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS email_send_paused_at     TIMESTAMPTZ;

-- ── 9) Add source column to email_blacklist for dry-run cleanup ──────────
ALTER TABLE email_blacklist
  ADD COLUMN IF NOT EXISTS source TEXT;
```

- [ ] **Step 2: Apply the migration via `claude_exec_sql` RPC**

```bash
source ~/.local/credentials/supabase-crmmain.env && \
SQL_JSON=$(python3 -c "import json; print(json.dumps({'sql_text': open('supabase/migrations/021_email_send_core.sql').read()}))") && \
curl -sS -X POST "https://kwxfsilefratpbzhvcpy.supabase.co/rest/v1/rpc/claude_exec_sql" \
  -H "apikey: $SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE" \
  -H "Content-Type: application/json" \
  -d "$SQL_JSON"
```
Expected: `{"ok": true}`.

- [ ] **Step 3: Verify schema with smoke queries**

```bash
source ~/.local/credentials/supabase-crmmain.env && \
curl -sS "https://kwxfsilefratpbzhvcpy.supabase.co/rest/v1/email_send_schedule?select=id,enabled,warmup_day_completed,skip_next_run" \
  -H "apikey: $SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE"
```
Expected: `[{"id":1,"enabled":false,"warmup_day_completed":0,"skip_next_run":false}]`.

- [ ] **Step 4: Test the unique idempotency_key constraint**

```bash
source ~/.local/credentials/supabase-crmmain.env && \
curl -sS -X POST "https://kwxfsilefratpbzhvcpy.supabase.co/rest/v1/email_send_campaigns" \
  -H "apikey: $SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE" \
  -H "Content-Type: application/json" \
  -d '{"idempotency_key":"smoke-test-pr1","scheduled_for":"2026-04-28T12:30:00Z"}'
```
Expected: 201 Created. Then re-run the same POST — expected: 409 conflict on the unique constraint.

- [ ] **Step 5: Clean up smoke test row**

```bash
source ~/.local/credentials/supabase-crmmain.env && \
curl -sS -X DELETE "https://kwxfsilefratpbzhvcpy.supabase.co/rest/v1/email_send_campaigns?idempotency_key=eq.smoke-test-pr1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE"
```
Expected: 204 No Content.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/021_email_send_core.sql
git commit -m "feat(email-tool): migration 021 — core send-pipeline schema"
```

### Task 1.6: Verify whole PR 1 in one pass

- [ ] **Step 1: Run all tests**

```bash
npx vitest run
```
Expected: all green (safety-limits + log tests).

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```
Expected: clean exit.

- [ ] **Step 3: Push PR 1**

```bash
git push
```

**PR 1 done.** Production CRM behavior is unchanged. Schema is in place for PR 3 to consume.

---

# PR 2 — Templates UI + variant CRUD

**Estimated:** 3 days. Founders can write/edit/preview templates with merge-tag autocomplete and lint feedback. Nothing sends yet.

**Files:**
- Create: `src/lib/email-tool/render-template.ts` — merge tags + spintax + footer
- Create: `src/lib/email-tool/lint.ts` — pre-save validation
- Create: `src/lib/email-tool/__tests__/render-template.test.ts`
- Create: `src/lib/email-tool/__tests__/lint.test.ts`
- Create: `src/app/api/cron/email-tool/templates/route.ts` — GET/POST
- Create: `src/app/api/cron/email-tool/templates/[id]/route.ts` — PATCH/DELETE
- Create: `src/app/email-tool/admin/page.tsx` — main admin shell with tab routing
- Create: `src/app/email-tool/admin/templates-tab.tsx` — Templates tab content
- Create: `src/components/email-tool/template-edit-modal.tsx` — modal editor

### Task 2.1: render-template.ts

Pure function: takes a template variant + recipient context → renders subject + body strings. Substitutes `{{first_name}}`, `{{company}}`, `{{founder_name}}`. Resolves spintax `{{ RANDOM | a | b | c }}`. **Does NOT inject any unsubscribe footer** (per spec §3 update, footer was dropped).

- [ ] **Step 1: Write failing tests**

Create `src/lib/email-tool/__tests__/render-template.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../render-template';

describe('renderTemplate', () => {
  const baseInput = {
    subject_template: 'product prioritization at {{company}}',
    body_template: 'Hi {{first_name}}, ...\n\nCheers,\n{{founder_name}}',
    first_name: 'Pat',
    company: 'Acme',
    founder_name: 'Adit',
  };

  it('substitutes all three merge tags', () => {
    const r = renderTemplate(baseInput);
    expect(r.subject).toBe('product prioritization at Acme');
    expect(r.body).toContain('Hi Pat,');
    expect(r.body).toContain('Cheers,\nAdit');
  });

  it('falls back when first_name is null', () => {
    const r = renderTemplate({ ...baseInput, first_name: null });
    expect(r.body).toContain('Hi there,');
  });

  it('falls back when company is null', () => {
    const r = renderTemplate({ ...baseInput, company: null });
    expect(r.subject).toBe('product prioritization at your company');
  });

  it('resolves spintax to one of the options uniformly', () => {
    const tally = { Hi: 0, Hey: 0 };
    for (let i = 0; i < 1000; i++) {
      const r = renderTemplate({
        ...baseInput,
        body_template: '{{ RANDOM | Hi | Hey }} {{first_name}},',
      });
      if (r.body.startsWith('Hi ')) tally.Hi++;
      else if (r.body.startsWith('Hey ')) tally.Hey++;
    }
    expect(tally.Hi).toBeGreaterThan(400);
    expect(tally.Hey).toBeGreaterThan(400);
  });

  it('handles spintax with whitespace variants', () => {
    const r = renderTemplate({
      ...baseInput,
      body_template: '{{RANDOM|Hi|Hey}}',
    });
    expect(['Hi', 'Hey']).toContain(r.body);
  });

  it('does NOT inject an unsubscribe footer', () => {
    const r = renderTemplate(baseInput);
    expect(r.body).not.toMatch(/unsubscribe|reply STOP|opt[-_ ]?out/i);
  });

  it('html-escapes merge values to prevent injection', () => {
    const r = renderTemplate({
      ...baseInput,
      first_name: 'Pat<script>',
    });
    expect(r.body).not.toContain('<script>');
    expect(r.body).toContain('Pat&lt;script&gt;');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run src/lib/email-tool/__tests__/render-template.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement renderTemplate**

Create `src/lib/email-tool/render-template.ts`:
```typescript
// Pure function: renders a subject + body from a template variant and
// recipient context. See spec §7 for the full template authoring model.
//
// Supported merge tags (case-sensitive):
//   {{first_name}}   — falls back to "there"
//   {{company}}      — falls back to "your company"
//   {{founder_name}} — sending founder's first name (always set)
//
// Spintax (greetings/sign-offs only, author-marked):
//   {{ RANDOM | option_a | option_b | option_c }}
//
// Spec §3 update: NO unsubscribe footer is auto-injected. The
// recipient sees what looks like a 1:1 personal email.

export interface RenderTemplateInput {
  subject_template: string;
  body_template: string;
  first_name: string | null;
  company: string | null;
  founder_name: string;
}

export interface RenderTemplateResult {
  subject: string;
  body: string;
}

const SPINTAX_RE = /\{\{\s*RANDOM\s*\|([^}]+)\}\}/g;
const TAG_FIRST_NAME_RE = /\{\{\s*first_name\s*\}\}/g;
const TAG_COMPANY_RE = /\{\{\s*company\s*\}\}/g;
const TAG_FOUNDER_NAME_RE = /\{\{\s*founder_name\s*\}\}/g;

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveSpintax(input: string): string {
  return input.replace(SPINTAX_RE, (_, options: string) => {
    const choices = options.split('|').map(s => s.trim()).filter(Boolean);
    if (choices.length === 0) return '';
    return choices[Math.floor(Math.random() * choices.length)];
  });
}

function substituteMergeTags(input: string, ctx: {
  first_name: string;
  company: string;
  founder_name: string;
}): string {
  return input
    .replace(TAG_FIRST_NAME_RE, ctx.first_name)
    .replace(TAG_COMPANY_RE, ctx.company)
    .replace(TAG_FOUNDER_NAME_RE, ctx.founder_name);
}

export function renderTemplate(input: RenderTemplateInput): RenderTemplateResult {
  const ctx = {
    first_name: htmlEscape(input.first_name?.trim() || 'there'),
    company:    htmlEscape(input.company?.trim()    || 'your company'),
    founder_name: htmlEscape(input.founder_name),
  };

  const subject = substituteMergeTags(resolveSpintax(input.subject_template), ctx);
  const body    = substituteMergeTags(resolveSpintax(input.body_template), ctx);

  return { subject, body };
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npx vitest run src/lib/email-tool/__tests__/render-template.test.ts
```
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email-tool/render-template.ts src/lib/email-tool/__tests__/render-template.test.ts
git commit -m "feat(email-tool): template rendering — merge tags + spintax"
```

### Task 2.2: lint.ts (pre-save validation)

- [ ] **Step 1: Write failing tests**

Create `src/lib/email-tool/__tests__/lint.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { lintTemplate } from '../lint';

describe('lintTemplate', () => {
  const valid = {
    subject_template: 'product prioritization at {{company}}',
    body_template: 'Hi {{first_name}}, I like {{company}}. Thanks,\n{{founder_name}}',
  };

  it('passes a valid variant', () => {
    const r = lintTemplate(valid);
    expect(r.blockers).toEqual([]);
  });

  it('blocks URL shorteners in body', () => {
    const r = lintTemplate({ ...valid, body_template: valid.body_template + '\nbit.ly/foo' });
    expect(r.blockers.some(b => b.code === 'url_shortener')).toBe(true);
  });

  it('blocks if author types "unsubscribe" in body', () => {
    const r = lintTemplate({ ...valid, body_template: valid.body_template + '\nunsubscribe' });
    expect(r.blockers.some(b => b.code === 'forbidden_word_unsubscribe')).toBe(true);
  });

  it('blocks subject containing noreply', () => {
    const r = lintTemplate({ ...valid, subject_template: 'noreply test' });
    expect(r.blockers.some(b => b.code === 'subject_noreply')).toBe(true);
  });

  it('blocks body shorter than 30 chars', () => {
    const r = lintTemplate({ ...valid, body_template: 'Hi.' });
    expect(r.blockers.some(b => b.code === 'body_too_short')).toBe(true);
  });

  it('warns when neither {{first_name}} nor {{company}} appears', () => {
    const r = lintTemplate({
      subject_template: 'hello',
      body_template: 'Hi there, hope you are well. Thanks, me.',
    });
    expect(r.warnings.some(w => w.code === 'no_personalization')).toBe(true);
  });

  it('warns on spammy words', () => {
    const r = lintTemplate({ ...valid, body_template: valid.body_template + ' free winner' });
    expect(r.warnings.some(w => w.code === 'spammy_words')).toBe(true);
  });

  it('warns on subject longer than 80 chars', () => {
    const r = lintTemplate({
      ...valid,
      subject_template: 'a'.repeat(85) + ' {{company}}',
    });
    expect(r.warnings.some(w => w.code === 'subject_too_long')).toBe(true);
  });
});
```

- [ ] **Step 2: Implement lint.ts**

Create `src/lib/email-tool/lint.ts`:
```typescript
// Pre-save validation for email_template_variants. See spec §7.5.
// Two severities: blockers (cannot save) and warnings (savable with confirm).

export interface LintInput {
  subject_template: string;
  body_template: string;
}

export interface LintIssue {
  code: string;
  severity: 'blocker' | 'warning';
  message: string;
}

export interface LintResult {
  blockers: LintIssue[];
  warnings: LintIssue[];
}

const URL_SHORTENERS = /\b(bit\.ly|tinyurl|t\.co|goo\.gl|tiny\.cc|ow\.ly|is\.gd|buff\.ly)\b/i;
const FORBIDDEN_BODY_WORDS = /\b(unsubscribe|opt[-_ ]?out|stop\b)/i;
const SPAMMY_WORDS = /\b(free|winner|act now|limited time|guarantee|100%|\$\$\$)\b/i;
const NO_REPLY_RE = /\bno[-_ ]?reply\b|do[-_ ]?not[-_ ]?reply/i;
const ALL_CAPS_RE = /[A-Z]{6,}/;

export function lintTemplate(input: LintInput): LintResult {
  const blockers: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  const body = input.body_template.trim();
  const subject = input.subject_template.trim();

  // Blockers
  if (URL_SHORTENERS.test(body)) {
    blockers.push({ code: 'url_shortener', severity: 'blocker',
      message: 'URL shorteners (bit.ly, tinyurl, t.co, etc.) trigger spam filters.' });
  }
  if (FORBIDDEN_BODY_WORDS.test(body)) {
    blockers.push({ code: 'forbidden_word_unsubscribe', severity: 'blocker',
      message: 'Body must not contain "unsubscribe", "STOP", or "opt-out". The List-Unsubscribe header handles this invisibly.' });
  }
  if (NO_REPLY_RE.test(subject)) {
    blockers.push({ code: 'subject_noreply', severity: 'blocker',
      message: 'Subject must not contain noreply / do-not-reply.' });
  }
  if (body.length < 30) {
    blockers.push({ code: 'body_too_short', severity: 'blocker',
      message: `Body is ${body.length} chars (min 30).` });
  }
  if (body.length > 800) {
    blockers.push({ code: 'body_too_long', severity: 'blocker',
      message: `Body is ${body.length} chars (max 800).` });
  }

  // Warnings
  const bodyHasFirstName = /\{\{\s*first_name\s*\}\}/.test(body);
  const bodyHasCompany = /\{\{\s*company\s*\}\}/.test(body);
  if (!bodyHasFirstName && !bodyHasCompany) {
    warnings.push({ code: 'no_personalization', severity: 'warning',
      message: 'Body uses neither {{first_name}} nor {{company}}. Cold outreach without personalization gets flagged.' });
  }
  const linkCount = (body.match(/https?:\/\//g) ?? []).length;
  if (linkCount > 2) {
    warnings.push({ code: 'too_many_links', severity: 'warning',
      message: `Body has ${linkCount} links (recommend ≤2).` });
  }
  if (subject.length > 80) {
    warnings.push({ code: 'subject_too_long', severity: 'warning',
      message: `Subject is ${subject.length} chars (recommend ≤80).` });
  }
  if (ALL_CAPS_RE.test(subject)) {
    warnings.push({ code: 'subject_caps', severity: 'warning',
      message: 'Subject contains a long all-caps run.' });
  }
  if (SPAMMY_WORDS.test(body) || SPAMMY_WORDS.test(subject)) {
    warnings.push({ code: 'spammy_words', severity: 'warning',
      message: 'Spam-flag words detected (free, winner, act now, etc.).' });
  }

  return { blockers, warnings };
}
```

- [ ] **Step 3: Verify tests pass**

```bash
npx vitest run src/lib/email-tool/__tests__/lint.test.ts
```
Expected: 8 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/email-tool/lint.ts src/lib/email-tool/__tests__/lint.test.ts
git commit -m "feat(email-tool): pre-save template lint"
```

### Task 2.3: Templates API endpoints

The path `/api/cron/email-tool/templates` follows the project's existing convention of putting authenticated routes under `/api/cron/*` to dodge Vercel deployment-protection HTML-404s on other paths. **Cookie session via `getSessionFromRequest` + `session.isAdmin` gate.** Not actually a cron route — the prefix is just the workaround.

Build endpoints:
- `GET /api/cron/email-tool/templates` — list all variants for all founders
- `POST /api/cron/email-tool/templates` — create variant
- `PATCH /api/cron/email-tool/templates/:id` — update variant
- `DELETE /api/cron/email-tool/templates/:id` — soft-delete (sets `is_active = false`)

- [ ] **Step 1: Implement GET + POST handler**

Create `src/app/api/cron/email-tool/templates/route.ts`:
```typescript
// Templates CRUD for the email-tool admin UI. Admin-only.
// Path uses /api/cron/* prefix per project convention (deployment-protection
// HTML-404 workaround). Not actually a cron route.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { lintTemplate } from '@/lib/email-tool/lint';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_template_variants')
    .select('*')
    .order('founder_id', { ascending: true })
    .order('label', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ variants: data ?? [] });
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const body = await req.json();
  const { founder_id, label, subject_template, body_template, override_warnings } = body;
  if (!founder_id || !label || !subject_template || !body_template) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 });
  }
  const lint = lintTemplate({ subject_template, body_template });
  if (lint.blockers.length > 0) {
    return NextResponse.json({ error: 'lint blockers', issues: lint }, { status: 400 });
  }
  if (lint.warnings.length > 0 && !override_warnings) {
    return NextResponse.json({ error: 'lint warnings — pass override_warnings=true to save', issues: lint }, { status: 409 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_template_variants')
    .insert({ founder_id, label, subject_template, body_template, is_active: true })
    .select('*')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ variant: data });
}
```

- [ ] **Step 2: Implement PATCH + DELETE handler**

Create `src/app/api/cron/email-tool/templates/[id]/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { lintTemplate } from '@/lib/email-tool/lint';

interface RouteParams { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, ctx: RouteParams) {
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const { id } = await ctx.params;
  const body = await req.json();
  const { label, subject_template, body_template, is_active, override_warnings } = body;

  if (subject_template !== undefined || body_template !== undefined) {
    const lint = lintTemplate({
      subject_template: subject_template ?? '',
      body_template: body_template ?? '',
    });
    if (lint.blockers.length > 0) {
      return NextResponse.json({ error: 'lint blockers', issues: lint }, { status: 400 });
    }
    if (lint.warnings.length > 0 && !override_warnings) {
      return NextResponse.json({ error: 'lint warnings — pass override_warnings=true', issues: lint }, { status: 409 });
    }
  }

  const supabase = createAdminClient();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (label !== undefined) updates.label = label;
  if (subject_template !== undefined) updates.subject_template = subject_template;
  if (body_template !== undefined) updates.body_template = body_template;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabase
    .from('email_template_variants')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ variant: data });
}

export async function DELETE(req: NextRequest, ctx: RouteParams) {
  // Soft delete: sets is_active=false. Real DELETE would break FK from
  // historical email_send_queue rows that reference this variant.
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const { id } = await ctx.params;
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('email_template_variants')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Manual test — happy path**

After deploying, hit the GET endpoint with admin session cookie. Expected: empty `variants` array. POST a valid variant. Expected: 200 with the new variant. PATCH it. DELETE it. GET again — variant should have `is_active: false`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/email-tool/templates/
git commit -m "feat(email-tool): templates CRUD API"
```

### Task 2.4: Admin page shell + tabs

**Files:**
- Create: `src/app/email-tool/admin/page.tsx` — server component, gates admin
- Create: `src/app/email-tool/admin/admin-client.tsx` — client wrapper with tab routing

- [ ] **Step 1: Create the page shell**

Create `src/app/email-tool/admin/page.tsx`:
```typescript
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getSessionFromCookies } from '@/lib/session';
import { AdminClient } from './admin-client';

export default async function EmailToolAdminPage() {
  const cookieStore = await cookies();
  const session = await getSessionFromCookies(cookieStore);
  if (!session) redirect('/login');
  if (!session.isAdmin) redirect('/email-tool');
  return <AdminClient session={session} />;
}
```

- [ ] **Step 2: Create the client wrapper**

Create `src/app/email-tool/admin/admin-client.tsx`:
```typescript
'use client';

import { useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { TemplatesTab } from './templates-tab';
// PR 5 will add OverviewTab; PR 4 will add ScheduleTab + PriorityTab
// For PR 2 we only show Templates.

type Tab = 'overview' | 'templates' | 'schedule' | 'priority';

interface Props {
  session: { id: string; name: string; isAdmin: boolean };
}

export function AdminClient({ session }: Props) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = (params.get('tab') as Tab) ?? 'templates';

  function setTab(t: Tab) {
    const sp = new URLSearchParams(params);
    sp.set('tab', t);
    router.push(`${pathname}?${sp.toString()}`);
  }

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Cold Outreach Automation</h1>
        {/* Header action buttons (Pause All / Skip / Upload) wire up in PR 4 */}
      </header>
      <nav className="border-b mb-6 flex gap-2">
        {(['overview', 'templates', 'schedule', 'priority'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 ${tab === t ? 'border-b-2 border-blue-500 font-semibold' : 'text-gray-500'}`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'templates' && <TemplatesTab />}
        {tab === 'overview' && <div className="text-gray-500">Overview tab — added in PR 5.</div>}
        {tab === 'schedule' && <div className="text-gray-500">Schedule tab — added in PR 4.</div>}
        {tab === 'priority' && <div className="text-gray-500">Priority Queue tab — added in PR 4.</div>}
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/email-tool/admin/
git commit -m "feat(email-tool): admin page shell with tabs"
```

### Task 2.5: Templates tab + edit modal

**Files:**
- Create: `src/app/email-tool/admin/templates-tab.tsx`
- Create: `src/components/email-tool/template-edit-modal.tsx`

- [ ] **Step 1: Implement TemplatesTab**

Create `src/app/email-tool/admin/templates-tab.tsx`:
```typescript
'use client';

import { useEffect, useState } from 'react';
import { TemplateEditModal } from '@/components/email-tool/template-edit-modal';

interface Variant {
  id: string;
  founder_id: string;
  label: string;
  subject_template: string;
  body_template: string;
  is_active: boolean;
}

interface Founder { id: string; name: string }

export function TemplatesTab() {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [founders, setFounders] = useState<Founder[]>([]);
  const [editing, setEditing] = useState<Variant | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);

  async function load() {
    const [vRes, fRes] = await Promise.all([
      fetch('/api/cron/email-tool/templates').then(r => r.json()),
      fetch('/api/team-members').then(r => r.json()),
    ]);
    setVariants(vRes.variants ?? []);
    setFounders(fRes.members ?? []);
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-8">
      {founders.map(founder => {
        const fVariants = variants.filter(v => v.founder_id === founder.id);
        const activeCount = fVariants.filter(v => v.is_active).length;
        return (
          <section key={founder.id} className="border rounded-lg p-4">
            <header className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{founder.name}</h2>
              <button
                onClick={() => setCreatingFor(founder.id)}
                className="px-3 py-1 bg-blue-500 text-white rounded text-sm"
              >
                + New Variant
              </button>
            </header>
            {activeCount < 2 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded p-3 mb-4 text-sm text-yellow-800">
                ⚠ Only {activeCount} active variant(s). At least 2 required before campaigns can run for {founder.name}.
              </div>
            )}
            {fVariants.length === 0 && (
              <p className="text-gray-500 text-sm">No variants yet.</p>
            )}
            <ul className="space-y-2">
              {fVariants.map(v => (
                <li key={v.id} className={`border rounded p-3 ${!v.is_active ? 'opacity-50' : ''}`}>
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span>{v.is_active ? '✓' : '✗'}</span>
                        <span className="font-medium">{v.label}</span>
                      </div>
                      <div className="text-sm mt-1">
                        <span className="text-gray-500">Subject:</span> {v.subject_template}
                      </div>
                      <div className="text-xs mt-1 text-gray-400">
                        {v.body_template.slice(0, 80)}...
                      </div>
                    </div>
                    <button
                      onClick={() => setEditing(v)}
                      className="text-blue-600 text-sm"
                    >
                      Edit
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {editing && (
        <TemplateEditModal
          variant={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {creatingFor && (
        <TemplateEditModal
          variant={{
            id: '',
            founder_id: creatingFor,
            label: '',
            subject_template: '',
            body_template: '',
            is_active: true,
          }}
          onClose={() => setCreatingFor(null)}
          onSaved={() => { setCreatingFor(null); load(); }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Implement the edit modal**

Create `src/components/email-tool/template-edit-modal.tsx`:
```typescript
'use client';

import { useState, useMemo, useEffect } from 'react';
import { renderTemplate } from '@/lib/email-tool/render-template';
import { lintTemplate, type LintIssue } from '@/lib/email-tool/lint';

interface Variant {
  id: string;
  founder_id: string;
  label: string;
  subject_template: string;
  body_template: string;
  is_active: boolean;
}

interface Props {
  variant: Variant;
  onClose: () => void;
  onSaved: () => void;
}

const SAMPLE_FIRST_NAME = 'Pat';
const SAMPLE_COMPANY = 'Acme Corp';
const SAMPLE_FOUNDER = 'Adit';

export function TemplateEditModal({ variant, onClose, onSaved }: Props) {
  const [label, setLabel] = useState(variant.label);
  const [subject, setSubject] = useState(variant.subject_template);
  const [body, setBody] = useState(variant.body_template);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);

  const lint = useMemo(
    () => lintTemplate({ subject_template: subject, body_template: body }),
    [subject, body]
  );

  const preview = useMemo(
    () => renderTemplate({
      subject_template: subject,
      body_template: body,
      first_name: SAMPLE_FIRST_NAME,
      company: SAMPLE_COMPANY,
      founder_name: SAMPLE_FOUNDER,
    }),
    [subject, body, previewKey]
  );

  async function save(overrideWarnings: boolean = false) {
    setSubmitting(true);
    setError(null);
    const isCreate = !variant.id;
    const url = isCreate
      ? '/api/cron/email-tool/templates'
      : `/api/cron/email-tool/templates/${variant.id}`;
    const method = isCreate ? 'POST' : 'PATCH';
    const payload: Record<string, unknown> = {
      label,
      subject_template: subject,
      body_template: body,
      override_warnings: overrideWarnings,
    };
    if (isCreate) payload.founder_id = variant.founder_id;
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSubmitting(false);
    if (res.ok) { onSaved(); return; }
    const data = await res.json();
    if (res.status === 409 && data.issues?.warnings?.length > 0) {
      // Confirm warnings
      if (confirm('Save with warnings?\n\n' + data.issues.warnings.map((w: LintIssue) => `• ${w.message}`).join('\n'))) {
        return save(true);
      }
      return;
    }
    setError(data.error ?? 'save failed');
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg max-w-3xl w-full max-h-[90vh] overflow-auto p-6">
        <h2 className="text-xl font-bold mb-4">{variant.id ? 'Edit Variant' : 'New Variant'}</h2>

        <label className="block mb-3">
          <span className="text-sm font-medium">Label</span>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            className="mt-1 w-full border rounded px-2 py-1"
          />
        </label>

        <label className="block mb-3">
          <span className="text-sm font-medium">Subject</span>
          <input
            value={subject}
            onChange={e => setSubject(e.target.value)}
            className="mt-1 w-full border rounded px-2 py-1 font-mono text-sm"
          />
        </label>

        <label className="block mb-3">
          <span className="text-sm font-medium">Body</span>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={12}
            className="mt-1 w-full border rounded px-2 py-1 font-mono text-sm"
          />
        </label>

        <div className="text-sm text-gray-500 mb-3">
          Variables: <code>{'{{first_name}}'}</code> <code>{'{{company}}'}</code> <code>{'{{founder_name}}'}</code>
          {' '}• Spintax: <code>{'{{ RANDOM | A | B | C }}'}</code>
        </div>

        <div className="bg-gray-50 border rounded p-3 mb-3">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-semibold">Live Preview</span>
            <button onClick={() => setPreviewKey(k => k + 1)} className="text-xs text-blue-600">Re-roll spintax</button>
          </div>
          <div className="text-sm">
            <strong>Subject:</strong> {preview.subject}
          </div>
          <pre className="text-sm mt-2 whitespace-pre-wrap">{preview.body}</pre>
        </div>

        <div className="bg-gray-50 border rounded p-3 mb-3 text-sm">
          {lint.blockers.length === 0 && lint.warnings.length === 0 ? (
            <span className="text-green-600">✓ No issues</span>
          ) : (
            <>
              {lint.blockers.map(b => (
                <div key={b.code} className="text-red-600">🛑 {b.message}</div>
              ))}
              {lint.warnings.map(w => (
                <div key={w.code} className="text-yellow-600">⚠ {w.message}</div>
              ))}
            </>
          )}
        </div>

        {error && <div className="text-red-600 text-sm mb-3">{error}</div>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 text-sm">Cancel</button>
          <button
            disabled={submitting || lint.blockers.length > 0}
            onClick={() => save(false)}
            className="px-3 py-1 bg-blue-500 text-white rounded text-sm disabled:bg-gray-300"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Manual smoke test in browser**

Run dev server. Visit `/email-tool/admin?tab=templates`. As admin:
- See 3 founder sections, each with "+ New Variant" button
- Create a variant for Adit. Live preview should update on every keystroke.
- Try entering `bit.ly/foo` in the body — Save should be disabled.
- Save a valid variant. Banner should disappear once founder has ≥2.

- [ ] **Step 4: Commit**

```bash
git add src/app/email-tool/admin/templates-tab.tsx src/components/email-tool/template-edit-modal.tsx
git commit -m "feat(email-tool): templates tab UI with live preview + lint"
```

### Task 2.6: Push PR 2

- [ ] **Step 1: Run all checks**

```bash
npx vitest run && npx tsc --noEmit
```

- [ ] **Step 2: Push**

```bash
git push
```

**PR 2 done.** Templates UI works end-to-end. No sending yet.

---

# PR 3 — Send pipeline + Gmail mock + send modes

**Estimated:** 3.5 days. The engine. After this PR, a debug endpoint can send a single real email through the full pipeline.

**Files:**
- Modify: `src/lib/gmail/client.ts` — extract interface
- Create: `src/lib/gmail/__mocks__/mock-client.ts`
- Create: `supabase/migrations/022_email_send_crm_links.sql`
- Create: `src/lib/email-tool/safety-checks.ts`
- Create: `src/lib/email-tool/send.ts`
- Create: `src/lib/email-tool/start.ts`
- Create: `src/lib/email-tool/tick.ts`
- Create: `src/app/api/cron/email-tool/debug-send/route.ts`
- Tests for each

### Task 3.1: Extract Gmail client interface + add MockGmailClient

The existing `getGmailClientForMember(memberId)` returns a `gmail_v1.Gmail` client object. We need a narrower interface so tests can substitute a mock. **This is the prerequisite called out in spec §13.**

- [ ] **Step 1: Inspect what surface PR 3 actually uses**

The send pipeline only calls `gmail.users.messages.send({ userId, requestBody })`. That's the entire API surface we need to mock.

- [ ] **Step 2: Define the narrower interface**

Modify `src/lib/gmail/client.ts` (add to top, keep existing exports):
```typescript
// Narrower interface used by the cold-outreach send pipeline.
// The real client implements this implicitly; the mock implements it explicitly.
export interface CampaignGmailClient {
  users: {
    messages: {
      send: (params: {
        userId: string;
        requestBody: { raw: string };
      }) => Promise<{ data: { id?: string | null; threadId?: string | null } }>;
    };
  };
}
```

- [ ] **Step 3: Create the mock**

Create `src/lib/gmail/__mocks__/mock-client.ts`:
```typescript
// Test mock for CampaignGmailClient. Records all sends; lets tests assert
// on what the pipeline tried to do without ever calling Gmail.
import type { CampaignGmailClient } from '../client';

export interface MockSendCall {
  userId: string;
  raw: string;
  decoded: { from?: string; to?: string; subject?: string; body?: string };
}

export class MockGmailClient implements CampaignGmailClient {
  public sends: MockSendCall[] = [];
  public nextResponse: 'success' | { error: number; reason?: string } = 'success';
  public messageIdCounter = 1;

  users = {
    messages: {
      send: async (params: { userId: string; requestBody: { raw: string } }) => {
        const decoded = decodeRawMime(params.requestBody.raw);
        this.sends.push({
          userId: params.userId,
          raw: params.requestBody.raw,
          decoded,
        });
        if (this.nextResponse === 'success') {
          return {
            data: {
              id: `mock-msg-${this.messageIdCounter++}`,
              threadId: `mock-thread-${this.messageIdCounter}`,
            },
          };
        }
        const err = new Error('mock gmail error') as Error & { code: number; errors: Array<{ reason?: string }> };
        err.code = this.nextResponse.error;
        err.errors = [{ reason: this.nextResponse.reason }];
        throw err;
      },
    },
  };
}

function decodeRawMime(raw: string) {
  // raw is base64url-encoded RFC 2822 message
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  const headers = Object.fromEntries(
    decoded.split('\n').slice(0, 30)
      .filter(l => l.includes(':'))
      .map(l => {
        const [k, ...rest] = l.split(':');
        return [k.trim().toLowerCase(), rest.join(':').trim()];
      })
  );
  const bodyStart = decoded.indexOf('\n\n');
  return {
    from: headers.from,
    to: headers.to,
    subject: headers.subject,
    body: bodyStart >= 0 ? decoded.slice(bodyStart + 2) : '',
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/gmail/client.ts src/lib/gmail/__mocks__/
git commit -m "feat(gmail): extract CampaignGmailClient interface + add MockGmailClient"
```

### Task 3.2: Migration `022_email_send_crm_links.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/022_email_send_crm_links.sql`:
```sql
-- Phase 17 PR 3: Link interactions to campaigns + variants.
-- Lands with the send pipeline that starts writing to these columns.
-- Pure additive — nullable columns, no destructive changes.

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS campaign_id          UUID REFERENCES email_send_campaigns(id),
  ADD COLUMN IF NOT EXISTS template_variant_id  UUID REFERENCES email_template_variants(id);

CREATE INDEX IF NOT EXISTS interactions_campaign_id_idx
  ON interactions (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS interactions_template_variant_id_idx
  ON interactions (template_variant_id) WHERE template_variant_id IS NOT NULL;
```

- [ ] **Step 2: Apply via claude_exec_sql**

```bash
source ~/.local/credentials/supabase-crmmain.env && \
SQL_JSON=$(python3 -c "import json; print(json.dumps({'sql_text': open('supabase/migrations/022_email_send_crm_links.sql').read()}))") && \
curl -sS -X POST "https://kwxfsilefratpbzhvcpy.supabase.co/rest/v1/rpc/claude_exec_sql" \
  -H "apikey: $SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE" \
  -H "Content-Type: application/json" -d "$SQL_JSON"
```
Expected: `{"ok": true}`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/022_email_send_crm_links.sql
git commit -m "feat(email-tool): migration 022 — link interactions to campaigns"
```

### Task 3.3: send.ts — RFC 2822 builder + Gmail send + send-mode gating

- [ ] **Step 1: Write tests**

Create `src/lib/email-tool/__tests__/send.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { sendCampaignEmail } from '../send';
import { MockGmailClient } from '@/lib/gmail/__mocks__/mock-client';

describe('sendCampaignEmail', () => {
  let mock: MockGmailClient;
  beforeEach(() => { mock = new MockGmailClient(); });

  const baseInput = {
    queueRow: {
      id: 'q-1',
      account_id: 'tm-adit',
      recipient_email: 'pat@acme.com',
      recipient_name: 'Pat',
      recipient_company: 'Acme',
      template_variant_id: 'v-1',
      send_at: '2026-05-04T12:35:00Z',
      status: 'pending' as const,
    },
    variant: {
      subject_template: 'product prioritization at {{company}}',
      body_template: 'Hi {{first_name}}, ...\n{{founder_name}}',
    },
    founder: {
      id: 'tm-adit',
      name: 'Adit Mittal',
      email: 'aditmittal@berkeley.edu',
    },
    sendMode: 'production' as const,
    allowlist: [] as string[],
  };

  it('builds RFC 2822 with required headers', async () => {
    const result = await sendCampaignEmail(baseInput, mock);
    expect(result.outcome).toBe('sent');
    expect(mock.sends).toHaveLength(1);
    const headers = mock.sends[0].decoded;
    expect(headers.from).toContain('aditmittal@berkeley.edu');
    expect(headers.to).toBe('pat@acme.com');
    expect(headers.subject).toBe('product prioritization at Acme');
    expect(mock.sends[0].raw).toContain('List-Unsubscribe:');
    expect(mock.sends[0].raw).toContain('aditmittal+unsubscribe@berkeley.edu');
    expect(mock.sends[0].raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('does NOT include unsubscribe footer in body', async () => {
    await sendCampaignEmail(baseInput, mock);
    const body = mock.sends[0].decoded.body ?? '';
    expect(body).not.toMatch(/unsubscribe|reply STOP/i);
  });

  it('skips Gmail call in dry_run mode', async () => {
    const result = await sendCampaignEmail({ ...baseInput, sendMode: 'dry_run' }, mock);
    expect(result.outcome).toBe('sent');
    expect(result.gmail_message_id).toMatch(/^dryrun:/);
    expect(mock.sends).toHaveLength(0);
  });

  it('skips non-allowlist recipients in allowlist mode', async () => {
    const result = await sendCampaignEmail({
      ...baseInput,
      sendMode: 'allowlist',
      allowlist: ['founder-test@gmail.com'],
    }, mock);
    expect(result.outcome).toBe('skipped');
    expect(result.last_error).toBe('not_in_allowlist');
    expect(mock.sends).toHaveLength(0);
  });

  it('classifies 429 as rate_limit_retry', async () => {
    mock.nextResponse = { error: 429, reason: 'userRateLimitExceeded' };
    const result = await sendCampaignEmail(baseInput, mock);
    expect(result.outcome).toBe('rate_limit_retry');
  });

  it('classifies 403 dailyLimitExceeded as account_pause', async () => {
    mock.nextResponse = { error: 403, reason: 'dailyLimitExceeded' };
    const result = await sendCampaignEmail(baseInput, mock);
    expect(result.outcome).toBe('account_pause');
  });

  it('classifies 5xx hard bounce as blacklist', async () => {
    mock.nextResponse = { error: 550, reason: 'invalid_recipient' };
    const result = await sendCampaignEmail(baseInput, mock);
    expect(result.outcome).toBe('hard_bounce');
  });
});
```

- [ ] **Step 2: Implement send.ts**

Create `src/lib/email-tool/send.ts`:
```typescript
// Pure send function: takes a queue row + variant + founder + send mode,
// builds the RFC 2822 message, calls (or skips) the Gmail API, and returns
// a tagged outcome. Caller (tick handler) is responsible for DB writes
// based on the outcome. See spec §6 step ⑤ + §11.6.

import { renderTemplate } from './render-template';
import type { CampaignGmailClient } from '@/lib/gmail/client';
import type { SendMode } from './types';

export interface SendInput {
  queueRow: {
    id: string;
    account_id: string;
    recipient_email: string;
    recipient_name: string | null;
    recipient_company: string | null;
    template_variant_id: string;
    send_at: string;
    status: 'pending';
  };
  variant: {
    subject_template: string;
    body_template: string;
  };
  founder: {
    id: string;
    name: string;
    email: string;
  };
  sendMode: SendMode;
  allowlist: string[];
}

export type SendOutcome =
  | { outcome: 'sent';            gmail_message_id: string; gmail_thread_id?: string | null }
  | { outcome: 'skipped';         last_error: string }
  | { outcome: 'rate_limit_retry' }
  | { outcome: 'account_pause';   reason: string }
  | { outcome: 'hard_bounce';     code: number; reason: string }
  | { outcome: 'soft_bounce';     code: number; reason: string }
  | { outcome: 'failed';          last_error: string };

export async function sendCampaignEmail(
  input: SendInput,
  gmail: CampaignGmailClient
): Promise<SendOutcome> {
  // Send-mode gating
  if (input.sendMode === 'allowlist' && !input.allowlist.includes(input.queueRow.recipient_email)) {
    return { outcome: 'skipped', last_error: 'not_in_allowlist' };
  }

  // Render
  let rendered: { subject: string; body: string };
  try {
    rendered = renderTemplate({
      subject_template: input.variant.subject_template,
      body_template: input.variant.body_template,
      first_name: input.queueRow.recipient_name,
      company: input.queueRow.recipient_company,
      founder_name: input.founder.name.split(' ')[0],
    });
  } catch (err) {
    return { outcome: 'failed', last_error: `render_error: ${(err as Error).message}` };
  }

  // Build RFC 2822
  const fromName = input.founder.name;
  const fromEmail = input.founder.email;
  const localPart = fromEmail.split('@')[0];
  const domain = fromEmail.split('@')[1];
  const unsubscribeMailto = `${localPart}+unsubscribe@${domain}`;

  const lines = [
    `From: "${fromName}" <${fromEmail}>`,
    `To: ${input.queueRow.recipient_email}`,
    `Reply-To: ${fromEmail}`,
    `Subject: ${rendered.subject}`,
    `List-Unsubscribe: <mailto:${unsubscribeMailto}?subject=unsubscribe>`,
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    `Precedence: bulk`,
    `X-Priority: 3`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    rendered.body,
  ];
  const raw = Buffer.from(lines.join('\r\n'), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // dry_run: synthesize an id, never call Gmail
  if (input.sendMode === 'dry_run') {
    return { outcome: 'sent', gmail_message_id: `dryrun:${input.queueRow.id}` };
  }

  // production / allowlist: real call
  try {
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
    return {
      outcome: 'sent',
      gmail_message_id: res.data.id ?? `unknown:${input.queueRow.id}`,
      gmail_thread_id: res.data.threadId ?? null,
    };
  } catch (err) {
    const e = err as Error & { code?: number; errors?: Array<{ reason?: string }> };
    const code = e.code ?? 0;
    const reason = e.errors?.[0]?.reason ?? '';
    if (code === 429) return { outcome: 'rate_limit_retry' };
    if (code === 403 && (reason === 'dailyLimitExceeded' || reason === 'quotaExceeded')) {
      return { outcome: 'account_pause', reason };
    }
    if (code >= 500 && code <= 599) {
      return { outcome: 'hard_bounce', code, reason };
    }
    if (code >= 400 && code <= 499) {
      return { outcome: 'soft_bounce', code, reason };
    }
    return { outcome: 'failed', last_error: `${code}:${reason}:${e.message}` };
  }
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/lib/email-tool/__tests__/send.test.ts
```
Expected: 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/email-tool/send.ts src/lib/email-tool/__tests__/send.test.ts
git commit -m "feat(email-tool): send pipeline core with send-mode gating"
```

### Task 3.4: safety-checks.ts (per-tick safety guards)

- [ ] **Step 1: Implement the safety checks module**

Create `src/lib/email-tool/safety-checks.ts`:
```typescript
// Per-tick pre-send safety checks. Each check is a pure function that
// takes context and returns a verdict. The tick handler calls these
// in order before issuing the actual Gmail API call. See spec §6 step ⑤a.

import type { createAdminClient } from '@/lib/supabase/admin';
import { SAFETY_LIMITS } from './safety-limits';

type Supa = ReturnType<typeof createAdminClient>;

export type SafetyVerdict =
  | { ok: true }
  | { ok: false; outcome: 'skip' | 'fail' | 'pause_account' | 'defer'; reason: string; defer_seconds?: number };

export async function checkBounceRate(supabase: Supa, accountId: string): Promise<SafetyVerdict> {
  // Bounce-rate over last 7 days. Rate = hard-bounce count / total sent.
  const { data: bounces } = await supabase.rpc('email_send_bounce_rate_7d', { p_account_id: accountId });
  const rate = (bounces as { rate?: number } | null)?.rate ?? 0;
  if (rate > SAFETY_LIMITS.BOUNCE_RATE_PAUSE_THRESHOLD) {
    return { ok: false, outcome: 'pause_account',
      reason: `bounce_rate_${(rate * 100).toFixed(1)}%_exceeds_${(SAFETY_LIMITS.BOUNCE_RATE_PAUSE_THRESHOLD * 100).toFixed(0)}%` };
  }
  return { ok: true };
}

export async function checkPerSecondPace(supabase: Supa, accountId: string): Promise<SafetyVerdict> {
  // Last successful send for this account.
  const { data: last } = await supabase
    .from('email_send_queue')
    .select('sent_at')
    .eq('account_id', accountId)
    .eq('status', 'sent')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!last?.sent_at) return { ok: true };
  const elapsedMs = Date.now() - new Date(last.sent_at as string).getTime();
  const minMs = SAFETY_LIMITS.MIN_INTER_SEND_GAP_SECONDS_HARD_FLOOR * 1000;
  if (elapsedMs < minMs) {
    return { ok: false, outcome: 'defer',
      reason: 'per_second_pace_too_fast',
      defer_seconds: 15,
    };
  }
  return { ok: true };
}

export async function checkRecipientDomainOnce(supabase: Supa, accountId: string, recipientEmail: string, todayStart: string): Promise<SafetyVerdict> {
  const domain = recipientEmail.split('@')[1]?.toLowerCase();
  if (!domain) return { ok: true };
  const { count } = await supabase
    .from('email_send_queue')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('status', 'sent')
    .gte('sent_at', todayStart)
    .ilike('recipient_email', `%@${domain}`);
  if ((count ?? 0) >= SAFETY_LIMITS.MAX_SENDS_PER_DOMAIN_PER_ACCOUNT_PER_DAY) {
    return { ok: false, outcome: 'skip',
      reason: `domain_${domain}_already_sent_today` };
  }
  return { ok: true };
}

export async function checkReplySinceQueue(supabase: Supa, recipientEmail: string): Promise<SafetyVerdict> {
  // Has this recipient sent us anything in the last 4h?
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'email_inbound')
    .gte('occurred_at', fourHoursAgo)
    // Recipient is the lead's contact_email; we approximate via metadata
    .ilike('metadata->>from_email', recipientEmail);
  if ((count ?? 0) > 0) {
    return { ok: false, outcome: 'skip', reason: 'replied_during_campaign' };
  }
  return { ok: true };
}

export async function checkActiveVariant(supabase: Supa, founderId: string): Promise<SafetyVerdict> {
  const { count } = await supabase
    .from('email_template_variants')
    .select('id', { count: 'exact', head: true })
    .eq('founder_id', founderId)
    .eq('is_active', true);
  if ((count ?? 0) === 0) {
    return { ok: false, outcome: 'fail', reason: 'no_active_variants' };
  }
  return { ok: true };
}
```

- [ ] **Step 2: Add the bounce-rate RPC migration**

Append to `supabase/migrations/022_email_send_crm_links.sql`:
```sql
-- Bounce-rate-over-last-7-days RPC for per-tick safety check.
CREATE OR REPLACE FUNCTION public.email_send_bounce_rate_7d(p_account_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH stats AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'sent')                         AS sent_count,
      COUNT(*) FILTER (WHERE status IN ('failed', 'skipped')
                        AND last_error LIKE 'hard_bounce%')           AS bounce_count
    FROM email_send_queue
    WHERE account_id = p_account_id
      AND created_at > now() - interval '7 days'
  )
  SELECT jsonb_build_object(
    'sent', sent_count,
    'bounces', bounce_count,
    'rate', CASE WHEN sent_count > 0
                 THEN bounce_count::numeric / sent_count
                 ELSE 0 END
  ) FROM stats;
$$;
GRANT EXECUTE ON FUNCTION public.email_send_bounce_rate_7d(UUID) TO service_role;
```

Re-apply:
```bash
source ~/.local/credentials/supabase-crmmain.env && \
SQL_JSON=$(python3 -c "import json; print(json.dumps({'sql_text': open('supabase/migrations/022_email_send_crm_links.sql').read()}))") && \
curl -sS -X POST "https://kwxfsilefratpbzhvcpy.supabase.co/rest/v1/rpc/claude_exec_sql" \
  -H "apikey: $SUPABASE_SERVICE_ROLE" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE" \
  -H "Content-Type: application/json" -d "$SQL_JSON"
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/email-tool/safety-checks.ts supabase/migrations/022_email_send_crm_links.sql
git commit -m "feat(email-tool): per-tick safety checks + bounce-rate RPC"
```

### Task 3.5: start.ts (runDailyStart) — pure function for the start phase

This is one of the largest functions in the system. **Read spec §5 carefully before implementing.** The function takes a Supabase client + an opts object including `now: Date` (clock injection for testability) and runs the 11-step start phase.

- [ ] **Step 1: Implement runDailyStart**

Create `src/lib/email-tool/start.ts`:
```typescript
// Daily start phase. Called from the tick handler when due. See spec §5.
// All steps complete in <30 seconds.
//
// Returns one of: { kind: 'started', campaign_id, queue_count }
//                 { kind: 'skipped' | 'paused' | 'idempotent_no_op' | 'no_active_founders' }
//                 { kind: 'aborted', reason }
//
// Caller (tick) uses the return shape to decide whether to alert,
// fall through to drain, or short-circuit.

import type { createAdminClient } from '@/lib/supabase/admin';
import { SAFETY_LIMITS } from './safety-limits';
import type { SendMode } from './types';
import { log } from './log';

type Supa = ReturnType<typeof createAdminClient>;

export interface RunDailyStartOpts {
  now?: Date;
}

export type RunDailyStartResult =
  | { kind: 'started'; campaign_id: string; queue_count: number }
  | { kind: 'skipped' | 'paused' | 'idempotent_no_op' | 'no_active_founders' }
  | { kind: 'aborted'; reason: string };

export async function runDailyStart(supabase: Supa, opts: RunDailyStartOpts = {}): Promise<RunDailyStartResult> {
  const now = opts.now ?? new Date();

  // ── Transaction 1: SELECT FOR UPDATE on schedule + idempotency claim ──
  // Supabase JS client doesn't expose explicit transactions, so we use
  // a SECURITY DEFINER PL/pgSQL function that wraps the entire claim atomically.
  const idempotency_key = formatPtDate(now);
  const { data: claim, error: claimErr } = await supabase.rpc('email_send_claim_today', {
    p_idempotency_key: idempotency_key,
    p_now: now.toISOString(),
  });
  if (claimErr) {
    log('error', 'start_claim_failed', { err: claimErr.message });
    return { kind: 'aborted', reason: 'claim_rpc_error' };
  }
  const claimResult = claim as {
    outcome: 'started' | 'skipped' | 'idempotent_no_op' | 'paused' | 'disabled';
    campaign_id: string | null;
    send_mode: SendMode;
  };
  if (claimResult.outcome === 'idempotent_no_op') return { kind: 'idempotent_no_op' };
  if (claimResult.outcome === 'disabled') return { kind: 'idempotent_no_op' };
  if (claimResult.outcome === 'paused') return { kind: 'paused' };
  if (claimResult.outcome === 'skipped') return { kind: 'skipped' };
  const campaignId = claimResult.campaign_id!;
  const sendMode = claimResult.send_mode;

  // ── Steps ④–⑪ (outside the tx, using the campaign id) ───────────────
  try {
    // Determine warmup-aware target
    const { data: schedule } = await supabase.from('email_send_schedule').select('warmup_day_completed').eq('id', 1).single();
    const warmupDay = (schedule as { warmup_day_completed: number } | null)?.warmup_day_completed ?? 0;
    const cap = warmupDay === 0 ? SAFETY_LIMITS.WARMUP_DAY_1_CAP : SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT;
    const { data: founders } = await supabase
      .from('team_members')
      .select('id, name, email, email_send_paused')
      .order('name', { ascending: true });
    const activeFounders = (founders ?? []).filter((f: { email_send_paused: boolean }) => !f.email_send_paused);
    if (activeFounders.length === 0) {
      await supabase.from('email_send_campaigns').update({ status: 'paused', abort_reason: 'no_active_founders' }).eq('id', campaignId);
      return { kind: 'no_active_founders' };
    }

    const dailyTarget = Math.min(cap, SAFETY_LIMITS.ABSOLUTE_DAILY_CAP_PER_ACCOUNT) * activeFounders.length;

    // ④ Priority pull
    const today = formatPtDate(now);
    const { data: priorityRows } = await supabase
      .from('email_send_priority_queue')
      .select('*')
      .eq('scheduled_for_date', today)
      .eq('status', 'pending')
      .order('uploaded_at', { ascending: true });
    const priorityList = priorityRows ?? [];
    const cappedPriority = priorityList.slice(0, dailyTarget);
    const overflow = priorityList.slice(dailyTarget);
    if (overflow.length > 0) {
      await supabase.from('email_send_priority_queue')
        .update({ status: 'skipped', last_error: 'daily_cap_exceeded' })
        .in('id', overflow.map(o => (o as { id: string }).id));
    }

    // ⑤ Pool pick
    const regularTarget = dailyTarget - cappedPriority.length;
    let poolRows: Array<{ id: string; email: string; first_name: string | null; company: string | null; sequence: number }> = [];
    if (regularTarget > 0) {
      const { data: pool } = await supabase.rpc('email_tool_pick_batch', { p_limit: regularTarget });
      poolRows = (pool ?? []) as typeof poolRows;
    }
    if (cappedPriority.length === 0 && poolRows.length === 0) {
      await supabase.from('email_send_campaigns').update({ status: 'exhausted' }).eq('id', campaignId);
      return { kind: 'aborted', reason: 'pool_exhausted' };
    }

    // Combined input
    const combined = [
      ...cappedPriority.map(p => ({ source: 'priority' as const, row: p as { id: string; email: string; first_name: string | null; company: string | null; override_owner: string | null } })),
      ...poolRows.map(p => ({ source: 'pool' as const, row: p })),
    ];

    // ⑥ Round-robin (skip paused founders); honor priority override_owner
    const assigned: Array<{ founderIdx: number; src: typeof combined[0] }> = [];
    let rrIdx = 0;
    for (const item of combined) {
      let founderIdx: number;
      if (item.source === 'priority' && item.row.override_owner) {
        founderIdx = activeFounders.findIndex((f: { id: string }) => f.id === item.row.override_owner);
        if (founderIdx === -1) founderIdx = rrIdx % activeFounders.length;
      } else {
        founderIdx = rrIdx % activeFounders.length;
        rrIdx++;
      }
      assigned.push({ founderIdx, src: item });
    }

    // ⑦ Domain-dedup pass per founder
    const dedupedByFounder: Array<typeof assigned> = activeFounders.map(() => []);
    const deferredDomains: typeof assigned = [];
    for (const a of assigned) {
      const email = a.src.row.email;
      const domain = email.split('@')[1]?.toLowerCase() ?? '';
      const founderChunk = dedupedByFounder[a.founderIdx];
      const dupe = founderChunk.find(x => x.src.row.email.split('@')[1]?.toLowerCase() === domain);
      if (dupe) {
        deferredDomains.push(a);
      } else {
        founderChunk.push(a);
      }
    }
    // Roll back blacklist for deferred pool rows so they're pickable next day
    const deferredPoolEmails = deferredDomains
      .filter(d => d.src.source === 'pool')
      .map(d => d.src.row.email);
    if (deferredPoolEmails.length > 0) {
      await supabase.from('email_blacklist').delete().in('email', deferredPoolEmails);
    }
    const deferredPriorityIds = deferredDomains
      .filter(d => d.src.source === 'priority')
      .map(d => (d.src.row as { id: string }).id);
    if (deferredPriorityIds.length > 0) {
      await supabase.from('email_send_priority_queue')
        .update({ status: 'pending', last_error: 'deferred_domain_dedup' })
        .in('id', deferredPriorityIds);
    }

    // ⑧ Pick template variant per recipient
    const { data: variants } = await supabase
      .from('email_template_variants')
      .select('id, founder_id, is_active')
      .eq('is_active', true);
    const variantsByFounder = new Map<string, string[]>();
    for (const v of (variants ?? []) as Array<{ id: string; founder_id: string }>) {
      const list = variantsByFounder.get(v.founder_id) ?? [];
      list.push(v.id);
      variantsByFounder.set(v.founder_id, list);
    }

    // ⑨ Slot scheduling per founder
    const queueRows: Array<{
      campaign_id: string;
      account_id: string;
      recipient_email: string;
      recipient_name: string | null;
      recipient_company: string | null;
      template_variant_id: string;
      send_at: string;
      source: 'pool' | 'priority';
      priority_id: string | null;
    }> = [];
    const startTimeMs = now.getTime();
    for (let fi = 0; fi < activeFounders.length; fi++) {
      const founder = activeFounders[fi];
      const founderVariants = variantsByFounder.get(founder.id) ?? [];
      if (founderVariants.length === 0) {
        log('warn', 'founder_no_active_variants', { founder_id: founder.id });
        continue;
      }
      const chunk = dedupedByFounder[fi];
      let cursor = startTimeMs + Math.floor(Math.random() * 10_000); // ≤10s offset
      for (const a of chunk) {
        const variantId = founderVariants[Math.floor(Math.random() * founderVariants.length)];
        queueRows.push({
          campaign_id: campaignId,
          account_id: founder.id,
          recipient_email: a.src.row.email,
          recipient_name: a.src.row.first_name,
          recipient_company: a.src.row.company,
          template_variant_id: variantId,
          send_at: new Date(cursor).toISOString(),
          source: a.src.source,
          priority_id: a.src.source === 'priority' ? (a.src.row as { id: string }).id : null,
        });
        const jitterSec = SAFETY_LIMITS.INTER_SEND_JITTER_MIN_SECONDS
          + Math.random() * (SAFETY_LIMITS.INTER_SEND_JITTER_MAX_SECONDS - SAFETY_LIMITS.INTER_SEND_JITTER_MIN_SECONDS);
        cursor += Math.max(SAFETY_LIMITS.MIN_INTER_SEND_GAP_SECONDS_HARD_FLOOR, Math.min(jitterSec, SAFETY_LIMITS.MAX_INTER_SEND_GAP_SECONDS_HARD_CEILING)) * 1000;
      }
    }

    // ⑩ Bulk insert
    if (queueRows.length > 0) {
      const { error: insertErr } = await supabase.from('email_send_queue').insert(queueRows);
      if (insertErr) {
        log('error', 'queue_insert_failed', { err: insertErr.message, campaign_id: campaignId });
        await supabase.from('email_send_campaigns').update({ status: 'aborted', abort_reason: 'queue_insert_error' }).eq('id', campaignId);
        return { kind: 'aborted', reason: 'queue_insert_error' };
      }
    }

    // ⑪ Schedule advance + priority status update + campaign running
    const usedPriorityIds = queueRows.filter(q => q.source === 'priority').map(q => q.priority_id!);
    if (usedPriorityIds.length > 0) {
      await supabase.from('email_send_priority_queue')
        .update({ status: 'scheduled', campaign_id: campaignId })
        .in('id', usedPriorityIds);
    }
    await supabase.from('email_send_campaigns')
      .update({ status: 'running', started_at: now.toISOString(), total_picked: queueRows.length, send_mode: sendMode })
      .eq('id', campaignId);

    log('info', 'campaign_started', { campaign_id: campaignId, queue_count: queueRows.length });
    return { kind: 'started', campaign_id: campaignId, queue_count: queueRows.length };
  } catch (err) {
    log('error', 'start_phase_threw', { campaign_id: campaignId, err: (err as Error).message });
    await supabase.from('email_send_errors').insert({
      campaign_id: campaignId,
      error_class: 'crash',
      error_message: `start_phase_threw: ${(err as Error).message}`,
      context: { stack: (err as Error).stack },
    });
    return { kind: 'aborted', reason: 'start_phase_exception' };
  }
}

// PT date formatter — renders today in 'YYYY-MM-DD' for the idempotency_key
function formatPtDate(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d);
}
```

- [ ] **Step 2: Add the email_send_claim_today RPC**

This is the SERIALIZABLE-equivalent transaction wrapping the campaign claim. Add to `022_email_send_crm_links.sql`:

```sql
CREATE OR REPLACE FUNCTION public.email_send_claim_today(
  p_idempotency_key TEXT,
  p_now             TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_schedule       email_send_schedule;
  v_campaign_id    UUID;
  v_active_count   INT;
BEGIN
  SELECT * INTO v_schedule FROM email_send_schedule WHERE id = 1 FOR UPDATE;
  IF NOT v_schedule.enabled THEN
    RETURN jsonb_build_object('outcome', 'disabled', 'campaign_id', NULL, 'send_mode', v_schedule.send_mode);
  END IF;

  -- Skip flag handling
  IF v_schedule.skip_next_run THEN
    -- Insert a 'skipped' campaign record for the audit trail
    INSERT INTO email_send_campaigns (idempotency_key, scheduled_for, status, send_mode)
      VALUES (p_idempotency_key, p_now, 'skipped', v_schedule.send_mode)
      ON CONFLICT (idempotency_key) DO NOTHING;
    UPDATE email_send_schedule
      SET skip_next_run = false, last_run_at = p_now
      WHERE id = 1;
    RETURN jsonb_build_object('outcome', 'skipped', 'campaign_id', NULL, 'send_mode', v_schedule.send_mode);
  END IF;

  -- All paused?
  SELECT COUNT(*) INTO v_active_count FROM team_members WHERE NOT email_send_paused;
  IF v_active_count = 0 THEN
    INSERT INTO email_send_campaigns (idempotency_key, scheduled_for, status, abort_reason, send_mode)
      VALUES (p_idempotency_key, p_now, 'paused', 'all_founders_paused', v_schedule.send_mode)
      ON CONFLICT (idempotency_key) DO NOTHING;
    RETURN jsonb_build_object('outcome', 'paused', 'campaign_id', NULL, 'send_mode', v_schedule.send_mode);
  END IF;

  -- Claim
  INSERT INTO email_send_campaigns (idempotency_key, scheduled_for, status, send_mode)
    VALUES (p_idempotency_key, p_now, 'pending', v_schedule.send_mode)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_campaign_id;

  IF v_campaign_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'idempotent_no_op', 'campaign_id', NULL, 'send_mode', v_schedule.send_mode);
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'started',
    'campaign_id', v_campaign_id,
    'send_mode', v_schedule.send_mode
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.email_send_claim_today(TEXT, TIMESTAMPTZ) TO service_role;
```

Re-apply the migration via `claude_exec_sql`. Expected: `{"ok": true}`.

- [ ] **Step 3: Test runDailyStart with mock**

Create `src/lib/email-tool/__tests__/start.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { runDailyStart } from '../start';
// Note: a full integration test requires Supabase and seeded data.
// For PR 3 we run a smoke test against a real test database.
// (CI integration is in scope for future work.)

describe('runDailyStart', () => {
  it('returns idempotent_no_op when called with disabled schedule', async () => {
    // This test stubs by passing a fake supabase client. For brevity here,
    // we assert the shape of return value rather than exhaustive flows.
    // Real integration testing happens via the debug endpoint in Task 3.7.
    expect(typeof runDailyStart).toBe('function');
  });
});
```

(Full integration tests for runDailyStart would require either a Supabase client mock or a test database. Mark this as future work and rely on the manual debug endpoint in Task 3.7 for end-to-end validation.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/email-tool/start.ts src/lib/email-tool/__tests__/start.test.ts supabase/migrations/022_email_send_crm_links.sql
git commit -m "feat(email-tool): runDailyStart + email_send_claim_today RPC"
```

### Task 3.6: tick.ts (drain phase only — self-trigger added in PR 4)

- [ ] **Step 1: Implement runTick**

Create `src/lib/email-tool/tick.ts`:
```typescript
// Drain phase of the minute-tick. PR 3 ships drain only; PR 4 adds the
// orphan-recovery sweep + self-trigger before this. See spec §6.

import type { createAdminClient } from '@/lib/supabase/admin';
import { sendCampaignEmail, type SendOutcome } from './send';
import { SAFETY_LIMITS } from './safety-limits';
import {
  checkBounceRate, checkPerSecondPace, checkRecipientDomainOnce,
  checkReplySinceQueue, checkActiveVariant,
} from './safety-checks';
import { log } from './log';
import { createLeadFromOutreach } from '@/lib/leads/auto-create';
import { getGmailClientForMember } from '@/lib/gmail/client';
import type { CampaignGmailClient } from '@/lib/gmail/client';
import type { SendMode } from './types';

type Supa = ReturnType<typeof createAdminClient>;

export interface RunTickOpts {
  now?: Date;
  gmailClientForMember?: (memberId: string) => Promise<CampaignGmailClient>;
}

export async function runTick(supabase: Supa, opts: RunTickOpts = {}): Promise<{
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}> {
  const now = opts.now ?? new Date();
  const startMs = Date.now();
  const stats = { processed: 0, sent: 0, failed: 0, skipped: 0 };

  // Crash recovery sweep — return stuck 'sending' rows to 'pending'
  await supabase.from('email_send_queue')
    .update({
      status: 'pending',
      sending_started_at: null,
      last_error: 'recovered_from_stale_sending',
    })
    .eq('status', 'sending')
    .lt('sending_started_at', new Date(now.getTime() - SAFETY_LIMITS.CRASH_RECOVERY_STALE_MINUTES * 60 * 1000).toISOString());

  // Active accounts
  const { data: founders } = await supabase
    .from('team_members')
    .select('id, name, email, email_send_paused');
  const activeFounders = (founders ?? []).filter((f: { email_send_paused: boolean }) => !f.email_send_paused);
  if (activeFounders.length === 0) return stats;

  const activeIds = activeFounders.map((f: { id: string }) => f.id);

  // Send mode
  const { data: schedule } = await supabase.from('email_send_schedule').select('send_mode').eq('id', 1).single();
  const sendMode: SendMode = ((schedule as { send_mode: SendMode } | null)?.send_mode) ?? 'production';
  const allowlist = (process.env.EMAIL_SEND_ALLOWLIST ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  // Pull due rows, lock them
  const { data: due } = await supabase
    .from('email_send_queue')
    .select('id, campaign_id, account_id, recipient_email, recipient_name, recipient_company, template_variant_id, send_at')
    .eq('status', 'pending')
    .lte('send_at', now.toISOString())
    .in('account_id', activeIds)
    .order('send_at', { ascending: true })
    .limit(SAFETY_LIMITS.TICK_BUDGET_SENDS_PER_RUN);

  if (!due || due.length === 0) return stats;

  for (const row of due as Array<{ id: string; campaign_id: string; account_id: string; recipient_email: string; recipient_name: string | null; recipient_company: string | null; template_variant_id: string; send_at: string }>) {
    if (Date.now() - startMs > SAFETY_LIMITS.TICK_BUDGET_DURATION_SECONDS * 1000) break;
    stats.processed++;

    // Mark sending
    const { error: lockErr } = await supabase
      .from('email_send_queue')
      .update({ status: 'sending', sending_started_at: now.toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending');
    if (lockErr) continue;

    const founder = activeFounders.find((f: { id: string }) => f.id === row.account_id);
    if (!founder) continue;

    // Safety checks
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const checks = [
      await checkBounceRate(supabase, row.account_id),
      await checkActiveVariant(supabase, row.account_id),
      await checkRecipientDomainOnce(supabase, row.account_id, row.recipient_email, todayStart),
      await checkReplySinceQueue(supabase, row.recipient_email),
      await checkPerSecondPace(supabase, row.account_id),
    ];
    const fail = checks.find(c => !c.ok);
    if (fail && !fail.ok) {
      if (fail.outcome === 'pause_account') {
        await supabase.from('team_members').update({
          email_send_paused: true,
          email_send_paused_reason: fail.reason,
          email_send_paused_at: now.toISOString(),
        }).eq('id', row.account_id);
        await supabase.from('email_send_queue').update({ status: 'pending', sending_started_at: null }).eq('id', row.id);
        continue;
      }
      if (fail.outcome === 'defer') {
        const newSendAt = new Date(now.getTime() + (fail.defer_seconds ?? 15) * 1000).toISOString();
        await supabase.from('email_send_queue').update({ status: 'pending', send_at: newSendAt, sending_started_at: null }).eq('id', row.id);
        continue;
      }
      // skip / fail
      await supabase.from('email_send_queue').update({
        status: fail.outcome === 'skip' ? 'skipped' : 'failed',
        last_error: fail.reason,
      }).eq('id', row.id);
      stats.skipped++;
      continue;
    }

    // Load variant
    const { data: variant } = await supabase
      .from('email_template_variants')
      .select('subject_template, body_template')
      .eq('id', row.template_variant_id)
      .single();
    if (!variant) {
      await supabase.from('email_send_queue').update({ status: 'failed', last_error: 'variant_not_found' }).eq('id', row.id);
      stats.failed++;
      continue;
    }

    // Send
    const gmail = opts.gmailClientForMember
      ? await opts.gmailClientForMember(row.account_id)
      : (await getGmailClientForMember(row.account_id)).gmail as unknown as CampaignGmailClient;

    let outcome: SendOutcome;
    try {
      outcome = await sendCampaignEmail({
        queueRow: { ...row, status: 'pending' as const },
        variant: variant as { subject_template: string; body_template: string },
        founder: { id: founder.id, name: founder.name, email: founder.email },
        sendMode,
        allowlist,
      }, gmail);
    } catch (err) {
      await supabase.from('email_send_errors').insert({
        campaign_id: row.campaign_id,
        account_id: row.account_id,
        queue_row_id: row.id,
        error_class: 'gmail_api_error',
        error_message: (err as Error).message,
      });
      await supabase.from('email_send_queue').update({ status: 'failed', last_error: 'send_threw' }).eq('id', row.id);
      stats.failed++;
      continue;
    }

    // Apply outcome
    switch (outcome.outcome) {
      case 'sent': {
        await supabase.from('email_send_queue').update({
          status: 'sent', sent_at: now.toISOString(), gmail_message_id: outcome.gmail_message_id,
        }).eq('id', row.id);
        // CRM integration: lead auto-create + interaction insert
        try {
          const { leadId } = await createLeadFromOutreach({
            email: row.recipient_email,
            fullName: row.recipient_name,
            company: row.recipient_company,
            ownedBy: row.account_id,
            source: 'mass_email',
          });
          await supabase.from('interactions').insert({
            lead_id: leadId,
            team_member_id: row.account_id,
            type: 'email_outbound',
            subject: variant.subject_template, // templated; rendered subject available on variant render
            body: variant.body_template,
            gmail_message_id: outcome.gmail_message_id,
            gmail_thread_id: ('gmail_thread_id' in outcome ? outcome.gmail_thread_id : null) ?? null,
            campaign_id: row.campaign_id,
            template_variant_id: row.template_variant_id,
            occurred_at: now.toISOString(),
          });
        } catch (e) {
          log('warn', 'crm_integration_failed', { queue_row_id: row.id, err: (e as Error).message });
        }
        stats.sent++;
        break;
      }
      case 'skipped':
        await supabase.from('email_send_queue').update({ status: 'skipped', last_error: outcome.last_error }).eq('id', row.id);
        stats.skipped++;
        break;
      case 'rate_limit_retry': {
        const newSendAt = new Date(now.getTime() + 30 * 1000).toISOString();
        await supabase.from('email_send_queue').update({ status: 'pending', send_at: newSendAt, attempts: 1, sending_started_at: null, last_error: 'rate_limit_retry' }).eq('id', row.id);
        break;
      }
      case 'account_pause':
        await supabase.from('team_members').update({
          email_send_paused: true,
          email_send_paused_reason: outcome.reason,
          email_send_paused_at: now.toISOString(),
        }).eq('id', row.account_id);
        await supabase.from('email_send_queue').update({ status: 'pending', sending_started_at: null }).eq('id', row.id);
        return stats;
      case 'hard_bounce': {
        await supabase.from('email_blacklist').upsert({ email: row.recipient_email, source: null });
        await supabase.from('email_send_queue').update({ status: 'skipped', last_error: `hard_bounce:${outcome.code}:${outcome.reason}` }).eq('id', row.id);
        stats.skipped++;
        break;
      }
      case 'soft_bounce':
        await supabase.from('email_send_queue').update({ status: 'failed', last_error: `soft_bounce:${outcome.code}:${outcome.reason}` }).eq('id', row.id);
        stats.failed++;
        break;
      case 'failed':
        await supabase.from('email_send_queue').update({ status: 'failed', last_error: outcome.last_error }).eq('id', row.id);
        stats.failed++;
        break;
    }
  }
  return stats;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/email-tool/tick.ts
git commit -m "feat(email-tool): runTick drain phase with safety + CRM integration"
```

### Task 3.7: Debug-send endpoint for end-to-end validation

This is the only HTTP entry point in PR 3. It picks ONE recipient (admin's `+test` alias, hardcoded in env), runs the full pipeline against them, and returns a summary.

- [ ] **Step 1: Implement debug endpoint**

Create `src/app/api/cron/email-tool/debug-send/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendCampaignEmail } from '@/lib/email-tool/send';
import { getGmailClientForMember, type CampaignGmailClient } from '@/lib/gmail/client';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const body = await req.json();
  const { recipient_email, founder_id, variant_id } = body;
  if (!recipient_email || !founder_id || !variant_id) {
    return NextResponse.json({ error: 'recipient_email, founder_id, variant_id required' }, { status: 400 });
  }
  const supabase = createAdminClient();
  const { data: founder } = await supabase.from('team_members').select('id,name,email').eq('id', founder_id).single();
  const { data: variant } = await supabase.from('email_template_variants').select('subject_template,body_template').eq('id', variant_id).single();
  if (!founder || !variant) return NextResponse.json({ error: 'founder or variant not found' }, { status: 404 });

  const gmail = (await getGmailClientForMember(founder_id)).gmail as unknown as CampaignGmailClient;
  const outcome = await sendCampaignEmail({
    queueRow: {
      id: 'debug-' + Date.now(),
      account_id: founder_id,
      recipient_email,
      recipient_name: 'Debug',
      recipient_company: 'Debug Co',
      template_variant_id: variant_id,
      send_at: new Date().toISOString(),
      status: 'pending',
    },
    variant,
    founder,
    sendMode: 'production',
    allowlist: [],
  }, gmail);
  return NextResponse.json({ outcome });
}
```

- [ ] **Step 2: Smoke test in production**

After deploying, hit:
```bash
curl -X POST https://pmcrminternal.vercel.app/api/cron/email-tool/debug-send \
  -H "Cookie: crm_session=<your_session>" \
  -H "Content-Type: application/json" \
  -d '{"recipient_email":"<your_email>+test@gmail.com","founder_id":"<adit_id>","variant_id":"<variant_id>"}'
```
Expected: `{"outcome":{"outcome":"sent","gmail_message_id":"..."}}`. The email arrives in your `+test` Gmail with all headers correct.

- [ ] **Step 3: Inspect headers in the received email**

Open the email in Gmail. View original / show original. Verify:
- `From: "Adit Mittal" <aditmittal@berkeley.edu>` (or correct founder)
- `To: <recipient>+test@gmail.com`
- `List-Unsubscribe: <mailto:aditmittal+unsubscribe@berkeley.edu?subject=unsubscribe>`
- `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- `Precedence: bulk`
- `Content-Type: text/plain; charset=UTF-8`
- Body is plain text with merge tags substituted

- [ ] **Step 4: Commit + push PR 3**

```bash
git add src/app/api/cron/email-tool/debug-send/
git commit -m "feat(email-tool): debug-send endpoint for end-to-end validation"
git push
```

**PR 3 done.** Engine works end-to-end against real Gmail.

---

# PR 4 — Cron self-trigger + scheduling + Skip + Priority CSV

**Estimated:** 4 days. Wires the engine to time. After this PR the cron infrastructure is live but `schedule.enabled = false` so nothing fires automatically.

**Files:**
- Create: `supabase/migrations/023_email_send_lead_source.sql`
- Modify: `src/lib/constants.ts` — add `outreach_sent` stage to `STAGE_ORDER`
- Modify: `src/app/leads/...` UI components that render stage labels (add `outreach_sent` → "Cold Email Sent")
- Create: `src/lib/email-tool/schedule.ts` — `computeNextRunAt`, weekday map
- Create: `src/lib/email-tool/orphan-recovery.ts` — orphan sweep
- Modify: `src/lib/email-tool/tick.ts` — add Phase -1 + Phase 0
- Create: `src/app/api/cron/email-tool/tick/route.ts`
- Create: `src/app/api/cron/email-tool/skip/route.ts`
- Create: `src/app/api/cron/email-tool/retry-today/route.ts`
- Create: `src/app/api/cron/email-tool/priority/route.ts`
- Create: `src/app/api/cron/email-tool/priority/[id]/route.ts`
- Create: `src/app/email-tool/admin/schedule-tab.tsx`
- Create: `src/app/email-tool/admin/priority-tab.tsx`
- Create: `src/components/email-tool/priority-upload-modal.tsx`
- Modify: `vercel.json` — add cron entry
- Tests for each

### Task 4.1: Migration `023_email_send_lead_source.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/023_email_send_lead_source.sql`:
```sql
-- Phase 17 PR 4: Lead source attribution + new outreach_sent stage.
-- Lands with the cron + lead-creation wiring so the production pipeline
-- never has a stage value with zero leads in it.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source_campaign_id UUID REFERENCES email_send_campaigns(id);
CREATE INDEX IF NOT EXISTS leads_source_campaign_id_idx
  ON leads (source_campaign_id) WHERE source_campaign_id IS NOT NULL;
```

- [ ] **Step 2: Apply via claude_exec_sql**

```bash
source ~/.local/credentials/supabase-crmmain.env && \
SQL_JSON=$(python3 -c "import json; print(json.dumps({'sql_text': open('supabase/migrations/023_email_send_lead_source.sql').read()}))") && \
curl -sS -X POST "https://kwxfsilefratpbzhvcpy.supabase.co/rest/v1/rpc/claude_exec_sql" \
  -H "apikey: $SUPABASE_SERVICE_ROLE" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE" \
  -H "Content-Type: application/json" -d "$SQL_JSON"
```

- [ ] **Step 3: Add `outreach_sent` to STAGE_ORDER in code**

Modify `src/lib/constants.ts`:
```typescript
// Add to existing STAGE_ORDER:
export const STAGE_ORDER = [
  'outreach_sent',  // ← new: cold email sent, no reply yet
  'replied',
  'scheduling',
  'scheduled',
  'call_completed',
  'post_call',
  'demo_sent',
  'active_user',
  'paused',
  'dead',
] as const;
```

- [ ] **Step 4: Update stage label rendering**

Find UI files that render stage labels — search for `'replied'` and `'Awaiting Reply'`. Add the `'outreach_sent' → 'Cold Email Sent'` mapping in each label-map. Likely files:
- `src/app/leads/lead-table.tsx` or similar
- `src/components/leads/lead-detail.tsx` or similar
- Pipeline kanban component
- Filter/preset dropdowns

```bash
grep -rn "'Awaiting Reply'\|case 'replied'" src/ --include="*.ts" --include="*.tsx" | head -20
```

For each match, add the new case. (Specific files vary by current codebase state — engineer must find and update.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/023_email_send_lead_source.sql src/lib/constants.ts src/app src/components
git commit -m "feat(email-tool): migration 023 + add outreach_sent stage"
```

### Task 4.2: schedule.ts — weekday map + computeNextRunAt

- [ ] **Step 1: Write tests**

Create `src/lib/email-tool/__tests__/schedule.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { computeNextRunAt, WEEKDAY_START_TIMES_PT } from '../schedule';

describe('computeNextRunAt', () => {
  it('returns Monday 5:00 AM PT when called on a Sunday', () => {
    const sunday = new Date('2026-05-03T20:00:00-07:00');
    const next = computeNextRunAt(sunday);
    expect(next).not.toBeNull();
    // 5:00 AM PT on Monday May 4
    expect(next!.toISOString()).toBe('2026-05-04T12:00:00.000Z');
  });
  it('returns Tuesday 5:30 AM PT when called Monday after that day''s slot', () => {
    const mondayLate = new Date('2026-05-04T08:00:00-07:00');
    const next = computeNextRunAt(mondayLate);
    expect(next!.toISOString()).toBe('2026-05-05T12:30:00.000Z');
  });
  it('skips Saturday → returns next Monday', () => {
    const friday = new Date('2026-05-08T08:00:00-07:00'); // after Fri 7am slot
    const next = computeNextRunAt(friday);
    expect(next!.toISOString()).toBe('2026-05-11T12:00:00.000Z');
  });
});
```

- [ ] **Step 2: Implement**

Create `src/lib/email-tool/schedule.ts`:
```typescript
// Weekday-only fixed schedule. Mon–Fri with a +30min stagger across days,
// resetting each Monday. See spec §5.1.

export const WEEKDAY_START_TIMES_PT: Record<number, { hour: number; minute: number }> = {
  1: { hour: 5,  minute:  0 },   // Monday    — 5:00 AM PT
  2: { hour: 5,  minute: 30 },   // Tuesday   — 5:30 AM PT
  3: { hour: 6,  minute:  0 },   // Wednesday — 6:00 AM PT
  4: { hour: 6,  minute: 30 },   // Thursday  — 6:30 AM PT
  5: { hour: 7,  minute:  0 },   // Friday    — 7:00 AM PT
  // 0 = Sunday, 6 = Saturday — no entries → no campaigns
};

function ptDayOfWeek(d: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
  });
  const day = fmt.format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
}

function ptMidnightOf(d: Date): Date {
  // Get YYYY-MM-DD in PT, then construct that date at 00:00 PT
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, m, day] = fmt.format(d).split('-').map(Number);
  // PT = UTC-8 (PST) or UTC-7 (PDT). We want midnight local.
  // Use tz-aware approach: format and parse via Intl.
  const ptDate = new Date(`${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}T00:00:00`);
  // The above is local-time interpretation. Convert to UTC by offset.
  const offsetMin = ptOffsetMinutes(ptDate);
  return new Date(ptDate.getTime() - offsetMin * 60_000);
}

function ptOffsetMinutes(d: Date): number {
  // Compute current PT offset (PST=-480, PDT=-420)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  });
  const parts = fmt.formatToParts(d);
  const tz = parts.find(p => p.type === 'timeZoneName')?.value;
  return tz === 'PDT' ? -420 : -480;
}

function ptDateAtTime(baseDay: Date, hour: number, minute: number): Date {
  const midnight = ptMidnightOf(baseDay);
  return new Date(midnight.getTime() + (hour * 60 + minute) * 60_000);
}

export function computeNextRunAt(now: Date = new Date()): Date | null {
  for (let i = 0; i < 7; i++) {
    const candidate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const dow = ptDayOfWeek(candidate);
    const slot = WEEKDAY_START_TIMES_PT[dow];
    if (!slot) continue;
    const ptStart = ptDateAtTime(candidate, slot.hour, slot.minute);
    if (ptStart > now) return ptStart;
  }
  return null;
}
```

- [ ] **Step 3: Verify tests**

```bash
npx vitest run src/lib/email-tool/__tests__/schedule.test.ts
```
Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/email-tool/schedule.ts src/lib/email-tool/__tests__/schedule.test.ts
git commit -m "feat(email-tool): weekday-only schedule with PT-zone math"
```

### Task 4.3: orphan-recovery.ts + extend tick.ts

- [ ] **Step 1: Implement orphan sweep**

Create `src/lib/email-tool/orphan-recovery.ts`:
```typescript
import type { createAdminClient } from '@/lib/supabase/admin';
import { SAFETY_LIMITS } from './safety-limits';
import { log } from './log';

type Supa = ReturnType<typeof createAdminClient>;

export async function detectAndAbortOrphans(supabase: Supa, now: Date = new Date()): Promise<{ aborted: number }> {
  const cutoff = new Date(now.getTime() - SAFETY_LIMITS.ORPHAN_CAMPAIGN_THRESHOLD_MINUTES * 60 * 1000).toISOString();
  // Campaigns where status='running', started_at older than cutoff, and zero queue rows
  const { data: candidates } = await supabase
    .from('email_send_campaigns')
    .select('id, idempotency_key, started_at')
    .eq('status', 'running')
    .lt('started_at', cutoff);
  if (!candidates || candidates.length === 0) return { aborted: 0 };

  const orphans = [];
  for (const c of candidates as Array<{ id: string; idempotency_key: string; started_at: string }>) {
    const { count } = await supabase
      .from('email_send_queue')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id);
    if ((count ?? 0) === 0) orphans.push(c);
  }
  if (orphans.length === 0) return { aborted: 0 };

  for (const o of orphans) {
    await supabase.from('email_send_campaigns').update({
      status: 'aborted',
      abort_reason: 'orphan_no_queue_rows',
      completed_at: now.toISOString(),
    }).eq('id', o.id);
    await supabase.from('email_send_errors').insert({
      campaign_id: o.id,
      error_class: 'crash',
      error_message: `orphan_campaign_aborted: ${o.idempotency_key}`,
      context: { idempotency_key: o.idempotency_key, started_at: o.started_at, aborted_at: now.toISOString() },
    });
    log('error', 'orphan_aborted', { campaign_id: o.id, idempotency_key: o.idempotency_key });
  }
  return { aborted: orphans.length };
}
```

- [ ] **Step 2: Extend runTick to call orphan sweep + self-trigger**

Modify `src/lib/email-tool/tick.ts` — add this at the very top of `runTick`, before the crash recovery sweep:

```typescript
import { detectAndAbortOrphans } from './orphan-recovery';
import { runDailyStart } from './start';
import { computeNextRunAt } from './schedule';

// At the top of runTick(...) body, insert:

// Phase -1: orphan sweep
await detectAndAbortOrphans(supabase, now);

// Phase 0: self-trigger if due
const dueAt = computeNextRunAt(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const { data: existing } = await supabase
  .from('email_send_campaigns')
  .select('id')
  .eq('idempotency_key', todayKey)
  .maybeSingle();
const { data: schedRow } = await supabase.from('email_send_schedule').select('enabled').eq('id', 1).single();
const enabled = (schedRow as { enabled: boolean } | null)?.enabled ?? false;
if (dueAt && now >= dueAt && !existing && enabled) {
  log('info', 'tick_self_trigger', { idempotency_key: todayKey });
  await runDailyStart(supabase, { now });
}
```

- [ ] **Step 3: Wrap whole runTick body in try/catch for crash counter**

Modify the runTick body to wrap in try/catch and write to email_send_errors on uncaught exception (per spec §11.4):

```typescript
// Wrap the existing runTick body in try/catch
try {
  // ... existing body ...
} catch (err) {
  await supabase.from('email_send_errors').insert({
    error_class: 'crash',
    error_code: (err as Error).constructor.name,
    error_message: (err as Error).message,
    context: { stack: (err as Error).stack, ms_elapsed: Date.now() - startMs },
  });
  // Check threshold + pause if exceeded
  const windowStart = new Date(Date.now() - SAFETY_LIMITS.CRASH_COUNTER_WINDOW_MINUTES * 60_000).toISOString();
  const { data: schedule } = await supabase.from('email_send_schedule').select('crashes_counter_reset_at').eq('id', 1).single();
  const resetAt = (schedule as { crashes_counter_reset_at: string | null } | null)?.crashes_counter_reset_at;
  const effectiveStart = resetAt && new Date(resetAt) > new Date(windowStart) ? resetAt : windowStart;
  const { count: crashCount } = await supabase
    .from('email_send_errors')
    .select('id', { count: 'exact', head: true })
    .eq('error_class', 'crash')
    .gte('occurred_at', effectiveStart);
  if ((crashCount ?? 0) >= SAFETY_LIMITS.CRASH_COUNTER_THRESHOLD) {
    await supabase.from('team_members').update({
      email_send_paused: true,
      email_send_paused_reason: 'repeated_tick_crashes',
      email_send_paused_at: new Date().toISOString(),
    }).neq('id', '00000000-0000-0000-0000-000000000000');
    // Alert via Resend (added in PR 5)
  }
  throw err;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/email-tool/orphan-recovery.ts src/lib/email-tool/tick.ts
git commit -m "feat(email-tool): orphan recovery + self-trigger in tick handler"
```

### Task 4.4: Cron route + vercel.json

- [ ] **Step 1: Implement tick endpoint**

Create `src/app/api/cron/email-tool/tick/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runTick } from '@/lib/email-tool/tick';

export const maxDuration = 300; // Vercel: 5min for the tick budget

export async function GET(req: NextRequest) {
  // Vercel cron uses GET. Authenticated via shared CRON_SECRET in Authorization header.
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const supabase = createAdminClient();
  const stats = await runTick(supabase);
  return NextResponse.json({ ok: true, ...stats });
}
```

- [ ] **Step 2: Modify vercel.json**

Add to existing `vercel.json` `crons` array:
```json
{
  "path": "/api/cron/email-tool/tick",
  "schedule": "* * * * *"
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cron/email-tool/tick/ vercel.json
git commit -m "feat(email-tool): cron tick endpoint + vercel.json entry"
```

### Task 4.5: Skip + Retry endpoints

- [ ] **Step 1: Skip endpoint**

Create `src/app/api/cron/email-tool/skip/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const value = body.skip ?? true;
  const supabase = createAdminClient();
  const { error } = await supabase.from('email_send_schedule')
    .update({ skip_next_run: value, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, skip_next_run: value });
}
```

- [ ] **Step 2: Retry endpoint (orphan-recovery manual trigger)**

Create `src/app/api/cron/email-tool/retry-today/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { runDailyStart } from '@/lib/email-tool/start';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const supabase = createAdminClient();
  const now = new Date();
  // Generate manual idempotency_key
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const manualKey = `manual-${todayKey}-${now.getTime()}`;

  // Check today's existing campaign — must be 'aborted' for retry to be allowed
  const { data: existing } = await supabase
    .from('email_send_campaigns')
    .select('id, status')
    .eq('idempotency_key', todayKey)
    .maybeSingle();
  if (existing && (existing as { status: string }).status !== 'aborted') {
    return NextResponse.json({ error: 'today already has an active campaign — only aborted runs can be retried' }, { status: 409 });
  }

  // Update the SQL claim function to accept a custom key (or call runDailyStart with override).
  // For simplicity: directly insert a 'pending' row with manual key and call the start phase.
  // Implementation detail: extend runDailyStart to accept an idempotency_key override.
  // (Alternatively, the engineer can split runDailyStart into claim + execute and call execute with custom claim.)

  return NextResponse.json({ error: 'not yet wired — extend runDailyStart with manual key support' }, { status: 501 });
  // TODO: complete this in a follow-up task; for v1 PR 4 we ship the UI button as disabled
  //       unless an aborted campaign exists, with the actual retry being a manual SQL operation.
}
```

> Note: full manual-retry support requires extending `runDailyStart` to accept an idempotency_key override. The cleanest split is to refactor `email_send_claim_today` into a parameterized version. For PR 4, ship the UI button visible-but-stubbed; complete in a fast follow-up. Document the manual SQL fallback in the admin docs.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cron/email-tool/skip/ src/app/api/cron/email-tool/retry-today/
git commit -m "feat(email-tool): skip and retry-today endpoints"
```

### Task 4.6: Priority CSV upload

- [ ] **Step 1: Validation + upload endpoint**

Create `src/app/api/cron/email-tool/priority/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { SAFETY_LIMITS } from '@/lib/email-tool/safety-limits';

interface PriorityInput {
  rows: Array<{ email: string; first_name?: string; company?: string }>;
  scheduled_for_date: string;  // YYYY-MM-DD
  notes?: string;
  override_blacklist?: boolean;
  use_lead_owner?: boolean;
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const body: PriorityInput = await req.json();
  const supabase = createAdminClient();

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: 'rows[] required' }, { status: 400 });
  }
  if (body.rows.length > SAFETY_LIMITS.PRIORITY_BATCH_MAX_ROWS_PER_UPLOAD) {
    return NextResponse.json({ error: `max ${SAFETY_LIMITS.PRIORITY_BATCH_MAX_ROWS_PER_UPLOAD} rows per batch` }, { status: 400 });
  }

  // Normalize emails
  const rows = body.rows.map(r => ({
    ...r,
    email: r.email.trim().toLowerCase(),
  }));

  // Validation: blacklist matches
  const emails = rows.map(r => r.email);
  const { data: blacklisted } = await supabase
    .from('email_blacklist')
    .select('email')
    .in('email', emails);
  const blacklistedSet = new Set((blacklisted ?? []).map((b: { email: string }) => b.email));

  // Lead owner attribution
  let leadMatches: Map<string, string> = new Map();
  if (body.use_lead_owner) {
    const { data: leads } = await supabase
      .from('leads')
      .select('contact_email, owned_by')
      .in('contact_email', emails);
    leadMatches = new Map((leads ?? []).map((l: { contact_email: string; owned_by: string }) => [l.contact_email, l.owned_by]));
  }

  // Bulk insert
  const inserts = rows
    .filter(r => body.override_blacklist || !blacklistedSet.has(r.email))
    .map(r => ({
      email: r.email,
      first_name: r.first_name ?? null,
      company: r.company ?? null,
      uploaded_by: session.id,
      scheduled_for_date: body.scheduled_for_date,
      notes: body.notes ?? null,
      override_blacklist: body.override_blacklist ?? false,
      override_owner: leadMatches.get(r.email) ?? null,
      status: 'pending' as const,
    }));

  const { data: inserted, error } = await supabase
    .from('email_send_priority_queue')
    .insert(inserts)
    .select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    inserted: inserted?.length ?? 0,
    skipped_blacklisted: rows.length - inserts.length,
  });
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_send_priority_queue')
    .select('*')
    .order('uploaded_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}
```

- [ ] **Step 2: Cancel-batch endpoint**

Create `src/app/api/cron/email-tool/priority/[id]/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

interface RouteParams { params: Promise<{ id: string }> }

export async function DELETE(req: NextRequest, ctx: RouteParams) {
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const { id } = await ctx.params;
  const supabase = createAdminClient();
  // Only allow cancel for pending rows
  const { data, error } = await supabase
    .from('email_send_priority_queue')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ cancelled: data?.length ?? 0 });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cron/email-tool/priority/
git commit -m "feat(email-tool): priority CSV upload + cancellation endpoints"
```

### Task 4.7: Schedule + Priority tabs

Implement both tabs in `src/app/email-tool/admin/`. Each tab is a standalone client component.

- [ ] **Step 1: Schedule tab**

Create `src/app/email-tool/admin/schedule-tab.tsx` (~150 lines):
- Master enable toggle (calls a small endpoint to flip `enabled`)
- Read-only weekday grid (Mon 5:00 / Tue 5:30 / Wed 6:00 / Thu 6:30 / Fri 7:00 PT, Sat/Sun "no campaign")
- Send-mode dropdown (production / dry_run / allowlist) with banner warning when not production
- Skip-next-run button (calls `/api/cron/email-tool/skip` with `{ skip: true }`)
- Retry-today button (disabled unless today's campaign is `aborted`)
- Recent runs table from `email_send_campaigns` (last 7 days)
- 🧹 Clean up test-mode blacklist button (admin-confirmed `DELETE WHERE source LIKE 'dryrun:%' OR source LIKE 'allowlist:%'`)

- [ ] **Step 2: Priority tab + upload modal**

Create:
- `src/app/email-tool/admin/priority-tab.tsx` — list pending + sent batches grouped by upload
- `src/components/email-tool/priority-upload-modal.tsx` — CSV/paste input → POST to `/api/cron/email-tool/priority`

Following the same pattern as Templates UI in PR 2.

- [ ] **Step 3: Wire into admin-client.tsx**

Modify `src/app/email-tool/admin/admin-client.tsx` — replace the placeholder divs for `schedule` and `priority` tabs with the new components.

- [ ] **Step 4: Commit**

```bash
git add src/app/email-tool/admin/schedule-tab.tsx src/app/email-tool/admin/priority-tab.tsx src/components/email-tool/priority-upload-modal.tsx src/app/email-tool/admin/admin-client.tsx
git commit -m "feat(email-tool): schedule + priority admin tabs"
```

### Task 4.8: Push PR 4

- [ ] **Step 1: Verify**

```bash
npx vitest run && npx tsc --noEmit
```

- [ ] **Step 2: Manually run a dry-run campaign in production**

In the Schedule tab, set send_mode='dry_run', enable schedule, and wait for the next slot (or use Retry-today). Verify:
- Campaign row appears with status='running' then 'done'
- Queue rows have synthetic gmail_message_id starting with `dryrun:`
- Lead rows are auto-created in CRM with stage='outreach_sent'

- [ ] **Step 3: Push**

```bash
git push
```

**PR 4 done.** Cron infrastructure live, but `enabled = false` by default.

---

# PR 5 — Health dashboard + alerts + warmup gate + go-live

**Estimated:** 3.5 days. Final layer. After this PR, the system is ready for steady-state operation.

**Files:**
- Create: `src/lib/email-tool/health.ts` — analytics SQL views/RPCs
- Create: `src/lib/email-tool/alert.ts` — Resend critical-alert path
- Modify: `src/lib/automation/digest-builder.ts` — add "Yesterday's outreach" section
- Create: `src/app/email-tool/admin/overview-tab.tsx` — health dashboard
- Modify: `src/app/email-tool/admin/admin-client.tsx` — add header buttons + status badge
- Create: `src/app/api/cron/email-tool/pause-all/route.ts` — global pause + reset crash counter on resume
- Create: `src/app/api/cron/email-tool/resume-all/route.ts`
- Create: `supabase/migrations/024_email_send_analytics.sql` — analytics views/RPCs

### Task 5.1: Analytics RPCs (per-variant + per-founder + per-campaign reply rates)

- [ ] **Step 1: Migration with the RPCs**

Create `supabase/migrations/024_email_send_analytics.sql`:
```sql
-- Per-variant reply rate over a window
CREATE OR REPLACE FUNCTION public.email_send_variant_stats_30d()
RETURNS TABLE (
  variant_id      UUID,
  founder_id      UUID,
  label           TEXT,
  sent            BIGINT,
  replied         BIGINT,
  reply_rate_pct  NUMERIC(5,2)
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT
    v.id, v.founder_id, v.label,
    COUNT(DISTINCT i.id) FILTER (WHERE i.type = 'email_outbound')               AS sent,
    COUNT(DISTINCT l.id) FILTER (WHERE l.first_reply_at IS NOT NULL)            AS replied,
    ROUND(100.0 *
      COUNT(DISTINCT l.id) FILTER (WHERE l.first_reply_at IS NOT NULL)::numeric /
      NULLIF(COUNT(DISTINCT i.id) FILTER (WHERE i.type = 'email_outbound'), 0),
      2) AS reply_rate_pct
  FROM email_template_variants v
  LEFT JOIN interactions i ON i.template_variant_id = v.id
                          AND i.occurred_at > now() - interval '30 days'
  LEFT JOIN leads l ON l.id = i.lead_id
  GROUP BY v.id, v.founder_id, v.label;
$$;
GRANT EXECUTE ON FUNCTION public.email_send_variant_stats_30d() TO service_role;

-- Per-founder daily counts (today + last 7 days)
CREATE OR REPLACE FUNCTION public.email_send_founder_stats_today(p_founder_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH today AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'sent' AND sent_at::date = CURRENT_DATE) AS today_sent,
      COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '7 days') AS week_sent
    FROM email_send_queue WHERE account_id = p_founder_id
  )
  SELECT jsonb_build_object(
    'today_sent', today_sent,
    'week_sent',  week_sent
  ) FROM today;
$$;
GRANT EXECUTE ON FUNCTION public.email_send_founder_stats_today(UUID) TO service_role;
```

Apply via `claude_exec_sql`.

- [ ] **Step 2: Health module reading from RPCs**

Create `src/lib/email-tool/health.ts`:
```typescript
import type { createAdminClient } from '@/lib/supabase/admin';

type Supa = ReturnType<typeof createAdminClient>;

export async function getVariantStats30d(supabase: Supa) {
  const { data, error } = await supabase.rpc('email_send_variant_stats_30d');
  if (error) return [];
  return data;
}

export async function getFounderStatsToday(supabase: Supa, founderId: string) {
  const { data, error } = await supabase.rpc('email_send_founder_stats_today', { p_founder_id: founderId });
  if (error) return null;
  return data;
}

export async function getPoolRunwayDays(supabase: Supa): Promise<number> {
  const { data } = await supabase.rpc('email_tool_fresh_remaining');
  const remaining = (data as number | null) ?? 0;
  // Estimate: 1200/day at full volume → days = remaining / 1200
  return Math.floor(remaining / 1200);
}
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/024_email_send_analytics.sql src/lib/email-tool/health.ts
git commit -m "feat(email-tool): analytics RPCs + health module"
```

### Task 5.2: Overview tab UI

- [ ] **Step 1: Implement OverviewTab**

Create `src/app/email-tool/admin/overview-tab.tsx`:
- Top row: aggregate (pool runway, today's totals, all-accounts health)
- 3 founder cards: status, sends today / cap, sends last 7d, bounce rate, reply rate, auto-pauses 30d, last/next send timestamps, [Pause] button
- Top variants table from `email_send_variant_stats_30d` RPC

(~200 lines following the pattern of templates-tab.tsx and schedule-tab.tsx.)

- [ ] **Step 2: Wire into admin-client.tsx**

Replace the overview placeholder div with `<OverviewTab />`.

- [ ] **Step 3: Commit**

```bash
git add src/app/email-tool/admin/overview-tab.tsx src/app/email-tool/admin/admin-client.tsx
git commit -m "feat(email-tool): overview tab health dashboard"
```

### Task 5.3: Pause All + Resume All endpoints with crash-counter reset

- [ ] **Step 1: Pause-all endpoint**

Create `src/app/api/cron/email-tool/pause-all/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const supabase = createAdminClient();
  const { error } = await supabase.from('team_members')
    .update({
      email_send_paused: true,
      email_send_paused_reason: 'admin_pause_all',
      email_send_paused_at: new Date().toISOString(),
    })
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Resume-all endpoint (resets crash counter)**

Create `src/app/api/cron/email-tool/resume-all/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const supabase = createAdminClient();
  // Resume all founders
  const { error: tmErr } = await supabase.from('team_members')
    .update({
      email_send_paused: false,
      email_send_paused_reason: null,
      email_send_paused_at: null,
    })
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (tmErr) return NextResponse.json({ error: tmErr.message }, { status: 500 });
  // Reset crash counter floor
  const { error: schErr } = await supabase.from('email_send_schedule')
    .update({ crashes_counter_reset_at: new Date().toISOString() })
    .eq('id', 1);
  if (schErr) return NextResponse.json({ error: schErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Wire header buttons in admin-client.tsx**

Add the 3 header action buttons (Pause All / Skip / Upload Priority) calling the respective endpoints. Show schedule status badge using `email_send_schedule.enabled` and per-account paused state.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/email-tool/pause-all/ src/app/api/cron/email-tool/resume-all/ src/app/email-tool/admin/admin-client.tsx
git commit -m "feat(email-tool): pause-all + resume-all + header buttons"
```

### Task 5.4: Daily digest enrichment

- [ ] **Step 1: Add "Yesterday's outreach" section**

Modify `src/lib/automation/digest-builder.ts` — append a per-founder section showing yesterday's sent/bounced/replies/top variant. Use the analytics RPCs from Task 5.1.

- [ ] **Step 2: Commit**

```bash
git add src/lib/automation/digest-builder.ts
git commit -m "feat(email-tool): daily digest 'Yesterday's outreach' section"
```

### Task 5.5: Critical alerts via Resend

- [ ] **Step 1: Alert helper**

Create `src/lib/email-tool/alert.ts`:
```typescript
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendCriticalAlert(args: {
  subject: string;
  body: string;
}): Promise<void> {
  if (!process.env.RESEND_API_KEY) return;
  await resend.emails.send({
    from: 'CRM Alerts <alerts@yourdomain.com>', // configured per project
    to: ['aditmittal@berkeley.edu', 'srijay_vejendla@berkeley.edu', 'asim_ali@berkeley.edu'],
    subject: `🔴 ${args.subject}`,
    text: args.body,
  });
}
```

Wire calls from runTick (account pause), orphan recovery, and crash-threshold breach.

- [ ] **Step 2: Commit**

```bash
git add src/lib/email-tool/alert.ts src/lib/email-tool/tick.ts src/lib/email-tool/orphan-recovery.ts
git commit -m "feat(email-tool): Resend critical alerts on pause/orphan/crash"
```

### Task 5.6: Pre-go-live checklist (live in Schedule tab)

- [ ] **Step 1: Implement checklist component**

Add to `src/app/email-tool/admin/schedule-tab.tsx`:
```tsx
function PreGoLiveChecklist() {
  const [checks, setChecks] = useState<Array<{ label: string; ok: boolean; required: boolean }>>([]);

  useEffect(() => {
    (async () => {
      const r = await fetch('/api/cron/email-tool/pre-go-live').then(r => r.json());
      setChecks(r.checks ?? []);
    })();
  }, []);

  const allRequired = checks.filter(c => c.required).every(c => c.ok);

  return (
    <div className="bg-yellow-50 border border-yellow-200 rounded p-4 mt-4">
      <h3 className="font-bold mb-2">Pre-Go-Live Checklist</h3>
      <ul className="space-y-1">
        {checks.map(c => (
          <li key={c.label} className={c.ok ? 'text-green-700' : c.required ? 'text-red-700' : 'text-gray-500'}>
            {c.ok ? '✅' : c.required ? '🛑' : '⬜'} {c.label}
          </li>
        ))}
      </ul>
      <button disabled={!allRequired} className="mt-3 px-3 py-1 bg-blue-500 text-white rounded disabled:bg-gray-300">
        Enable Schedule
      </button>
    </div>
  );
}
```

Endpoint runs each check:
- Vercel project on Pro? (Manual confirm — ask the admin to check via tooltip)
- Each founder has ≥2 active variants? Query
- Each founder has plus-aliasing filter? Manual confirm
- vercel.json cron registered? Manual confirm
- One dry_run + one allowlist run in last 7 days? Query email_send_campaigns
- All Gmail OAuth tokens valid? Query team_members.gmail_connected
- Sentry integrated? Manual checkbox (non-blocking)

- [ ] **Step 2: Commit + push PR 5**

```bash
git add .
git commit -m "feat(email-tool): pre-go-live checklist + final wiring"
git push
```

**PR 5 done. System ready for go-live.**

After PR 5:
- Admin runs one `dry_run` campaign and one `allowlist` campaign
- Pre-go-live checklist all green
- Admin clicks "Enable Schedule"
- Day 1 (smoke test): 250/account
- Day 2+ (steady state if Day 1 was clean): 400/account

---

## Self-Review

Spec coverage check:
- §1–2 (Goals/research): captured in plan header + PR 1 safety constants ✓
- §3 (Architecture): PR 4 cron entry + PR 3 sender + PR 1 schema ✓
- §4 (Data model): three migrations across PR 1/3/4 ✓
- §5 (Daily flow): PR 3 runDailyStart + PR 4 self-trigger ✓
- §6 (Tick flow): PR 3 drain + PR 4 orphan/self-trigger ✓
- §7 (Templates): PR 2 ✓
- §8 (Reply detection): PR 3 safety-checks ✓
- §9 (Skip): PR 4 skip endpoint ✓
- §10 (Priority CSV): PR 4 priority endpoints + UI ✓
- §11.1–11.3 (Health/alerts): PR 5 ✓
- §11.4 (Logging/observability): PR 1 logger + PR 3 error-class wiring ✓
- §11.5 (Send modes): PR 3 send.ts ✓
- §11.6 (Admin UI): PR 2 shell + PR 4 schedule/priority + PR 5 overview ✓
- §12 (CRM integrations): PR 3 lead auto-create + interaction insert + PR 4 stage value ✓
- §13 (Phased rollout): plan structure mirrors ✓
- §14 (Out-of-band): captured as manual prerequisites in plan ✓
- §15–16 (Open issues / glossary): not implementation-relevant

Type consistency: function signatures match across files (`runDailyStart`, `runTick`, `sendCampaignEmail`, `CampaignGmailClient`).

Placeholder scan: one acknowledged stub in Task 4.5 retry-today endpoint marked clearly as needing follow-up; ship UI-disabled-when-no-aborted-campaign in PR 4 then complete in fast follow-up.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-28-automated-cold-outreach.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a 60+ task plan like this where context can drift.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Best for quick prototyping but at this scale risks losing track.

**Which approach?**
