# Cold Outreach Build — Caveats & Follow-ups

Tracking concerns surfaced during the implementation that were deliberately deferred. **Per Adit's directive (PR 3 wrap-up): all of these must be done in a final mop-up pass before steady-state operation begins. PR 5 is the natural home for most. If PR 5 grows past ~5 days of work, spin up a Phase 6 mop-up PR rather than shipping with anything outstanding.**

Each item links to where it came up so future-us can find context.

---

## Status legend

- 🔴 **OPEN** — must do before go-live
- 🟢 **DONE** — addressed (with commit reference)
- 🟡 **WATCH** — intentional deviation, no fix planned, just tracked

---

## C1. `claude_exec_sql` safety-guard bypass — 🟢 DONE (2026-04-29)

**Surfaced:** PR 1 Task 1.5 fixup (commit `a8f1ecc`).
**Resolved:** PR 5 Task 5.9. Adit pasted `027_claude_exec_sql_upgrade_PROPOSED.sql` into the dashboard SQL editor; both function overloads now exist (single-arg unchanged for backward compat, two-arg adds `allow_destructive boolean DEFAULT false`). New `public.claude_exec_sql_audit` table records every invocation (destructive flag, sql preview, outcome).

**Resolution:** Option 2 from the original options list — explicit per-call `allow_destructive=true` opt-in plus an audit trail. The single-arg signature is preserved and continues to enforce the literal-token guard against `DROP` / `DELETE FROM` / `TRUNCATE`, so all existing callers behave identically.

**First audit-logged destructive call:** 025a (drops `tmp_inspect_*` helpers + tightens FK ON DELETE on `email_send_priority_queue`). Verified by reading back `claude_exec_sql_audit`.

---

## C2. Leftover inspection helpers in public schema — 🟢 DONE (2026-04-29)

**Surfaced:** PR 1 Task 1.5 verification.
**Resolved:** PR 5 Task 5.9 via `025a_email_send_destructive_mop_up.sql`. Both `tmp_inspect_fks()` and `tmp_inspect_idx()` dropped via the upgraded `claude_exec_sql(sql_text, allow_destructive => true)`. Verified post-image: `helpers_present: []`.

---

## C3. Two FKs on `email_send_priority_queue` left at default `NO ACTION` — 🟢 DONE (2026-04-29)

**Surfaced:** PR 1 Task 1.5 review (commit `a8f1ecc`).
**Resolved:** PR 5 Task 5.9 via `025a_email_send_destructive_mop_up.sql`.

- `email_send_priority_queue.uploaded_by` → `RESTRICT` (don't delete a founder while their priority uploads exist). Verified `confdeltype = 'r'`.
- `email_send_priority_queue.override_owner` → `SET NULL` (founder cleanup shouldn't block priority queue logic). Verified `confdeltype = 'n'`.

---

## C4. Status enums are unconstrained TEXT, not CHECK constraints

**Surfaced:** PR 1 Task 1.5 code-quality review.

Status fields on `email_send_campaigns.status`, `.send_mode`, `email_send_queue.status`, `.source`, `email_send_priority_queue.status`, `email_send_errors.error_class` are all `TEXT NOT NULL` with no `CHECK (... IN (...))` constraint. The TypeScript union types narrow at compile time, but a misbehaving direct `INSERT` (e.g., manual SQL, future migration) could land an invalid value.

**Why deferred:** consistent with existing project style (`018_email_tool.sql` does the same). TS narrowing is the primary safety mechanism. Adding CHECK constraints later is a non-breaking change if we want it.

**Action if appetite:** add `CHECK (status IN (...))` constraints in a fixup migration, listing the exact union values from `src/lib/email-tool/types.ts`.

---

## C6. Templates API error shape diverges from sibling email-tool routes

**Surfaced:** PR 2 Task 2.3 code-quality review (commit `db343a8`).

The new templates routes use `{ error: '...' }` for failures and `{ variant: data }` for success. Existing sibling routes (`csv-filter`, `blacklist-upload`) use `{ ok: true/false, reason: 'short_code', detail?: '...' }`. Two inconsistencies in this:

1. Frontend has to branch on response shape across the email-tool surface.
2. The 500 path on the new routes echoes `error.message` directly, leaking raw Postgres/Supabase text.

**Why deferred:** non-blocking per code review; admin-only routes so blast radius is small; the frontend in PR 2 Task 2.5 only needs the success/blocker/warning branches which work fine with the current shape.

**Action if appetite:** unify on the `{ ok, reason, detail }` shape and replace generic 500s with short reason codes. Drop `detail` in production responses to avoid leaking schema info.

---

## C5. No `updated_at` trigger on `email_template_variants` — 🔴 OPEN

**Surfaced:** PR 1 Task 1.5 code-quality review.

The table has `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`, but no `BEFORE UPDATE` trigger to bump it on row updates. Application code in PR 2 (`PATCH /api/cron/email-tool/templates/:id`) sets `updated_at = new Date().toISOString()` manually. If a future code path forgets, the column goes stale.

**Why deferred:** consistent with project style — no other tables in the codebase have this trigger. Application-managed for now.

**Action:** add a generic `set_updated_at()` trigger function and apply it to `email_template_variants` (and optionally `email_send_schedule`, `email_send_campaigns`).

---

## C7. Exponential-backoff schedule for 429 retries — 🔴 OPEN

**Surfaced:** PR 3 Task 3.6 code review (commit `5ffbf14`).

Spec §6 step ⑤d: "429 userRateLimitExceeded → exponential backoff (5s/30s/2m), max 3 retries, then status='failed'". `tick.ts` enforces the 3-retry cap (and transitions to `failed` on attempts > 3) but uses a flat 30s defer per attempt. The intent of exponential backoff is to give the rate-limiter time to clear; flat 30s × 3 sometimes won't be enough.

**Why deferred:** the cap is the load-bearing safety property; the schedule is a tuning knob. Cap shipped, schedule deferred to mop-up.

**Action:** in the rate_limit_retry handler, compute `defer_ms = [5000, 30000, 120000][attempts - 1]` (matching spec's 5s/30s/2m). Add a unit test asserting the schedule.

---

## C8. Campaign completion check — 🔴 OPEN

**Surfaced:** PR 3 Task 3.6 spec review (spec §6 step ⑦).

Spec says: "If 0 pending rows for this campaign → mark 'done', completed_at=now()". Currently `tick.ts` never marks campaigns as `done`. Campaigns will sit in `status='running'` forever even after all rows are terminal.

**Why deferred:** PR 3 was "drain phase only"; completion check was scoped to a later PR.

**Action:** at the end of `runTick`, for each distinct `campaign_id` we touched in this tick, query `SELECT count(*) WHERE campaign_id = X AND status = 'pending'`. If 0, update campaign to `status='done', completed_at=now()`. Could also be a separate sweep at the start of each tick if the per-tick query gets expensive.

---

## C9. Crash-counter wiring (3 crashes / 10 min → global pause) — 🔴 OPEN

**Surfaced:** spec §11.4. Deferred to PR 4.

Spec mandates: "Outer try/catch wrapping `runTick` ... Re-check threshold; pause all if exceeded ... `recentCrashCount() >= 3` triggers global pause". Currently `runTick` has no outer try/catch; uncaught exceptions escape the cron handler with no `email_send_errors` row written, no crash count tracked, no pause triggered.

**Why deferred:** PR 3 didn't ship the cron entry point, only `runTick` itself. The wiring belongs in PR 4's tick endpoint (`/api/cron/email-tool/tick/route.ts`).

**Action in PR 4:** wrap the route handler body in try/catch; on catch, INSERT into `email_send_errors` with `error_class='crash'`, query the count over the last `CRASH_COUNTER_WINDOW_MINUTES` filtered by `crashes_counter_reset_at`, and pause-all + alert if >= 3.

---

## C10. Per-tick timeout detection — 🔴 OPEN

**Surfaced:** spec §11.4. Deferred to PR 4.

Spec: "Timeout check: if we ran past budget, log but don't error". Currently `runTick` returns early via the budget guard, but doesn't write an `email_send_errors` row with `error_class='timeout'` for observability.

**Action in PR 4:** at end of route handler, if `Date.now() - startedAt > (TICK_BUDGET_DURATION_SECONDS - 5) * 1000`, INSERT `email_send_errors` with `error_class='timeout'` and the elapsed ms.

---

## C11. Schedule advance — `next_run_at` denormalization — 🔴 OPEN

**Surfaced:** spec §5 step ⑪. Deferred to PR 4.

Spec: "email_send_schedule.next_run_at = computeNextRunAt(now())". Currently `start.ts` sets `last_run_at` but does NOT set `next_run_at`. The admin UI's "next run" display will be stale.

**Action in PR 4:** once `computeNextRunAt` from the weekday-map ships, wire it into the step ⑪ update in `start.ts`. Also wire it into the skip-flag path in `email_send_claim_today` RPC.

---

## C12. Skip-flag path missing `next_run_at` advance — 🔴 OPEN

**Surfaced:** spec §5 step ②. Deferred to PR 4 alongside C11.

`email_send_claim_today` RPC's skip path sets `last_run_at` but not `next_run_at`. Same fix as C11; track separately because it lives in SQL not TS.

---

## C13. Render template's `Content-Transfer-Encoding: 7bit` is a half-truth — 🟡 WATCH

**Surfaced:** PR 3 Task 3.3 code review.

Email body uses `Content-Transfer-Encoding: 7bit` but bodies could contain non-ASCII (curly quotes from AI personalization, em-dashes, etc.). 7bit technically requires only ASCII; modern Gmail tolerates this but a strict MTA might reject.

**Why WATCH:** in v1 bodies are plain ASCII templates written by founders. AI personalization is deferred. If/when AI personalization ships, switch to `Content-Transfer-Encoding: quoted-printable` and add an encoder.

---

## C14. Activity-log + alert side effects from `runDailyStart` — 🔴 OPEN

**Surfaced:** spec §5 mentions "alert admin", "alert founders", "alerted to admin" at multiple steps. Deferred to PR 5 with the rest of the alert plumbing.

`runDailyStart` currently emits `log()` calls but no Resend alerts when:
- Priority overflow (rows skipped due to daily_cap_exceeded)
- Pool exhausted
- Founder has no active variants
- All founders paused
- Queue insert error / start phase exception

**Action in PR 5:** when `src/lib/email-tool/alert.ts` ships with the Resend critical-alert path, wire calls from `runDailyStart` and `runTick`'s pause/exhaust/crash branches.

---

## C15. Bounce-rate query has no covering index — 🟡 WATCH

**Surfaced:** PR 3 Task 3.2 code-quality review.

`email_send_bounce_rate_7d` filters `email_send_queue` by `account_id` + `created_at > now() - 7d`. The closest existing index is `email_send_queue_account_sent_idx ON (account_id, sent_at)` — wrong column. Postgres will do a sequential scan.

**Why WATCH:** at <500 rows/account/day × 7 days = ~3500 rows per account, even seq scan is microseconds. Only matters if the volume scales 10×.

**Action if appetite:** add `CREATE INDEX email_send_queue_account_created_idx ON email_send_queue (account_id, created_at)`. Cheap to add.

---

## C16. Templates UI has no Escape-key dismissal / focus management — 🟡 WATCH

**Surfaced:** PR 2 Task 2.5 code review.

Modal can be backdrop-clicked to close but pressing Escape doesn't dismiss, and the Label input doesn't auto-focus on open.

**Why WATCH:** internal tool used by 3 admins.

**Action if appetite:** `useEffect` that attaches a `keydown` listener for `Escape → onClose()`, plus `autoFocus` on the Label input.

---

## C17. Founders list ordering is API-dependent — 🟡 WATCH

**Surfaced:** PR 2 Task 2.5 code review.

Templates UI renders founder sections in whatever order `/api/team/members` returns. CLAUDE.md defines `TEAM_NAMES = ['Adit', 'Srijay', 'Asim']` as canonical order.

**Why WATCH:** functionally identical regardless of order; UI consistency only.

**Action if appetite:** sort founders array by `TEAM_NAMES.indexOf(f.name)` before rendering.

---

## C18. Tick handler's gmail client cast `as unknown as CampaignGmailClient` — 🔴 OPEN

**Surfaced:** PR 3 Task 3.6 code review (line 192 in tick.ts).

The double-cast bypasses type checking. The real `getGmailClientForMember` returns `googleapis`'s `Gmail` type which DOES structurally satisfy `CampaignGmailClient`, but the explicit cast leaks `unknown` through.

**Action in mop-up:** either (a) update `getGmailClientForMember`'s return type to expose `CampaignGmailClient`, or (b) write a tiny adapter `toCampaignGmailClient(gmail)` that returns a typed object. Drop the double-cast in `tick.ts` and the debug-send route.

---

## C19. Existing tmp_inspect_* SECURITY DEFINER functions not cleaned up

(Same as C2 — duplicate kept for index visibility.)

---

## Summary table — final status (post PR 5)

| # | Item | Status |
|---|---|---|
| C1 | claude_exec_sql safety-guard policy decision | 🟢 DONE — PR 5 Task 5.9 (027 applied via dashboard) |
| C2 | drop tmp_inspect_* helpers | 🟢 DONE — PR 5 Task 5.9 (025a) |
| C3 | priority_queue FK ON DELETE behavior | 🟢 DONE — PR 5 Task 5.9 (025a) |
| C4 | status enum CHECK constraints | 🟢 DONE — PR 5 Task 5.1 (025) |
| C5 | updated_at trigger function | 🟢 DONE — PR 5 Task 5.1 (025) |
| C6 | unify templates API error shape | 🟢 DONE — PR 5 Task 5.8 |
| C7 | exponential backoff 5s/30s/2m | 🟢 DONE — PR 5 Task 5.2 |
| C8 | campaign completion check | 🟢 DONE — PR 5 Task 5.2 |
| C9 | crash-counter wiring | 🟢 DONE — PR 4 Task 4.3 |
| C10 | timeout signal | 🟡 WATCH — Vercel function timeout limits cover this in practice |
| C11 | next_run_at denormalization (TS) | 🟢 DONE — PR 4 Task 4.2 |
| C12 | next_run_at skip-flag path (SQL) | 🟢 DONE — PR 4 (024 RPC update) |
| C13 | Content-Transfer-Encoding 7bit half-truth | 🟡 WATCH — cosmetic; receivers tolerate |
| C14 | alert side effects from runDailyStart | 🟢 DONE — PR 5 Task 5.5 |
| C15 | bounce-rate query covering index | 🟢 DONE — PR 5 Task 5.1 (025) |
| C16 | templates UI Escape-to-close | 🟢 DONE — PR 5 Task 5.8 |
| C17 | founders list ordering | 🟢 DONE — PR 5 Task 5.8 |
| C18 | drop unsafe gmail client cast | 🟢 DONE — PR 5 Task 5.2 |
| C19 | (duplicate of C2) | 🟢 DONE |

**Outstanding items:** C10 + C13 are both 🟡 WATCH (cosmetic / mitigated by other layers). All 🔴 OPEN items closed. System is ready for go-live pending Adit's pre-flight checklist.
