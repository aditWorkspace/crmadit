# Action Chat — Bulk CRM Operations via Natural Language

**Date:** 2026-04-26
**Status:** Planning (awaiting approval)
**Scope:** New `/actions` tab. Founder types in plain English; AI parses into structured tool calls; each tool call previews exactly what it will change; user confirms; backend executes with audit logging. Bulk operations (move N leads, update N attributes) are first-class.

## Problem

The kanban + leads table are great for one-off edits but painful for bulk work:

- "Move these 15 prospects from `replied` to `scheduling`" requires 15 clicks.
- "Give me a CSV of everyone in demo_sent we contacted in the last 8 days" → no in-app way to do it; you'd export everything and filter manually.
- "What's Roop's status?" → 3 clicks: leads → search → open detail.

The insights chat is for product-scope analysis (read-only over transcripts). Action chat is the opposite: structured CRUD over the lead pipeline, with safety rails.

## Non-negotiables

1. **No silent wrong actions.** If the AI is uncertain, it asks — never guesses on a mutation.
2. **Every mutation previews first.** User sees the exact lead list + before/after diff before clicking Confirm. Read operations execute immediately.
3. **Hard cap on bulk magnitude.** Mutations affecting >25 leads at once require a second explicit confirmation showing the full list.
4. **Audit log entry for every action.** Already-existing `activity_log` table covers this — we just write to it.
5. **Idempotent where possible.** Stage move to current stage = no-op, not error.

## Architecture

### Tool-call pipeline

```
User text
  ↓
Action Router LLM (deepseek-v4-pro, with tool-calling enabled)
  ↓ emits 1+ tool_use blocks
Tool dispatcher (server-side)
  ↓ for each tool:
    - validate args against zod schema
    - if read tool: execute, render result inline
    - if mutation tool: build preview (resolve names→IDs, show diff),
      mark as PENDING, render confirmation card
  ↓
User clicks "Confirm" or "Cancel" on each pending mutation
  ↓
On Confirm: execute, write activity_log, render result
On Cancel: drop the pending action
```

### The tool catalog (12 tools)

Read tools (auto-execute, no confirmation):

| Tool | Purpose | Returns |
|---|---|---|
| `find_leads` | Filter leads by stage, owner, time window, name/company/email substring, tag, priority | List of {id, name, company, stage, owner, last_contact_at, …} |
| `get_lead` | Full detail for one lead by id/name/email | Lead row + recent interactions, action items, transcripts |
| `count_leads` | Same filters as find_leads, just returns count | Number + breakdown by stage |
| `recent_activity` | Activity log query — what happened in last N days, optionally for a person/team member | Timeline rows |
| `export_csv` | Same filters as find_leads → returns a CSV download link | URL to ephemeral file |

Mutation tools (preview → confirm → execute):

| Tool | Purpose | Preview shows |
|---|---|---|
| `move_leads_to_stage` | Bulk stage change (uses existing `changeStage` to fire side-effects: action items, follow-ups, auto-emails) | Each lead's current → target stage |
| `update_lead_priority` | Bulk set priority (critical/high/medium/low) | Each lead's current → target priority |
| `update_lead_owner` | Bulk reassign owner to a team member | Each lead's current → target owner |
| `add_tags` / `remove_tags` | Bulk add/remove tags | Each lead's tag delta |
| `add_note` | Add a note interaction to one lead | Note text + lead context |
| `pause_leads` | Move to `paused`, optionally with `paused_until` | Same as move_leads_to_stage but to paused, plus snooze date |
| `mark_dead` | Move to `dead` (dismisses follow-ups) | Same as move_leads_to_stage to dead |
| `archive_leads` | Set is_archived=true (soft delete) | List of leads to hide from default view |

Schema validation: every tool input is a Zod schema; the dispatcher rejects malformed calls before they touch the DB. Lead identifiers can be passed as UUIDs, contact emails, or contact-name+company combos (the dispatcher resolves and rejects on ambiguity).

### Confirmation card UX

When a mutation tool's preview comes back, the chat renders a card like:

```
┌───────────────────────────────────────────────────────────┐
│ [Move 12 leads → demo_sent]                               │
│                                                           │
│ Roop Pal @ Bild AI         scheduling     → demo_sent     │
│ Lindsey @ Nexterity        scheduling     → demo_sent     │
│ Max @ Pangram Labs         scheduling     → demo_sent     │
│ … 9 more                                  [Show all]      │
│                                                           │
│ Side effects: each will trigger the demo-sent stage hook  │
│ (auto-creates 4h follow-up + sets demo_sent_at).          │
│                                                           │
│ [Cancel]                              [Confirm 12 moves]  │
└───────────────────────────────────────────────────────────┘
```

If the count > 25, the Confirm button is disabled and the card forces a "Type DELETE 27 to confirm" intent-check. Friction at the magnitude that matters.

### Top 30 example prompts → tool mapping

Each is what I'd actually expect to land in production. Bucket = the tool that fires.

**Lookups (find_leads / get_lead):**
1. "What's the status of Roop Pal?" → `get_lead("Roop Pal")`
2. "Find anyone at Bild AI" → `find_leads(company="Bild AI")`
3. "Who hasn't replied in two weeks?" → `find_leads(stale_for_days=14)`
4. "Show me everyone Adit owns in scheduling" → `find_leads(owner="Adit", stage="scheduling")`
5. "How many active users do we have?" → `count_leads(stage="active_user")`
6. "List my high-priority leads" → `find_leads(owner=me, priority="high")`
7. "Find Heath" → `find_leads(name_contains="Heath")`
8. "Anyone with tag 'enterprise'?" → `find_leads(tag="enterprise")`

**Activity / history (recent_activity):**
9. "What changed yesterday?" → `recent_activity(days=1)`
10. "Show me everything Srijay did this week" → `recent_activity(actor="Srijay", days=7)`
11. "What happened with Bild AI in the last month?" → `recent_activity(lead="Bild AI", days=30)`

**CSV exports (export_csv):**
12. "Give me a CSV of everyone in demo_sent we reached out to in the last 8 days" → `export_csv(stage="demo_sent", contacted_within_days=8)`
13. "Export emails for active_user leads" → `export_csv(stage="active_user", columns=["contact_email","contact_name","company_name"])`
14. "CSV of everyone Asim owns" → `export_csv(owner="Asim")`
15. "Dump all transcripts with their sentiment" → (new tool) `export_transcripts_csv()` — *flagged as future addition*

**Bulk stage moves (move_leads_to_stage, with confirmation):**
16. "Move these to demo_sent: roop@bild.ai, max@pangram.com, lindsey@nexterity.com" → `move_leads_to_stage(emails=[…], to="demo_sent")`
17. "Move everyone we had a call with this week to call_completed" → `find_leads(stage="scheduled", call_was_in_last_days=7)` then `move_leads_to_stage(...)` — chained, both previewed
18. "Bump Roop and Heath up a stage" → resolve, then move each forward by one stage in `STAGE_ORDER`
19. "Mark Bild AI as call_completed" → `move_leads_to_stage(["Bild AI"], "call_completed")`

**Bulk attribute changes:**
20. "Set priority high on all of Adit's scheduled calls" → `update_lead_priority(filter={owner:Adit, stage:scheduled}, priority="high")`
21. "Reassign all of Asim's leads to me" → `update_lead_owner(filter={owner:Asim}, to=me)`
22. "Tag everyone in active_user as 'paying'" → `add_tags(filter={stage:active_user}, tags=["paying"])`

**Notes / soft mutations:**
23. "Add a note to Roop: 'mentioned wants Linear integration'" → `add_note(lead="Roop Pal", text="…")`
24. "Note on everyone in scheduling: 'follow up next Mon'" → `add_note(filter=…, text=…)` — bulk note, previewed

**Pause / dead / archive:**
25. "Pause these leads until next Monday: …" → `pause_leads(ids=[…], until=next_monday)`
26. "Mark Lindsey as dead" → `mark_dead(["Lindsey"])`
27. "Archive every lead in dead stage older than 60 days" → `archive_leads(filter={stage:dead, age_days:60})`

**Compound / smart:**
28. "For everyone who replied this week, move them to scheduling" → chain `find_leads` + `move_leads_to_stage`
29. "Find duplicates of any active lead and tell me which" → `find_leads()` + dedup heuristic — *flagged as v2 feature*
30. "What's stale right now and why?" → `find_leads(stale=true)` + `count_leads` breakdown — descriptive, not destructive

Anything outside these → AI says "I can't do that yet — here's the closest I can do." Refuse, don't invent.

### Files to create

- `src/lib/actions/tools.ts` — registry: `{ name, schema (zod), description, kind: 'read'|'mutation', preview, execute }`
- `src/lib/actions/dispatcher.ts` — single entry point: take a tool call, validate, run preview-or-execute
- `src/lib/actions/resolvers.ts` — fuzzy resolve "Roop" / "roop@bild.ai" / "Bild AI" → lead ID(s), reject on ambiguity
- `src/lib/actions/csv.ts` — CSV builder + ephemeral file write to Supabase Storage
- `src/lib/ai/action-chat-orchestrator.ts` — call deepseek-v4-pro with tool definitions; handle multi-turn tool use loop
- `src/app/api/action-chat/route.ts` — POST endpoint; takes user message + session, returns tool calls + previews
- `src/app/api/action-chat/confirm/route.ts` — POST endpoint; takes pending action ID, executes
- `src/app/actions/page.tsx` — the new tab UI: ChatGPT-style sidebar (reuse what we just built), confirmation cards inline
- `src/components/actions/confirmation-card.tsx` — reusable preview-and-confirm card
- New nav entry in `src/components/layout/top-nav.tsx`
- New table in DB: `action_chat_pending` — pending mutations (id, tool_name, args, preview_data, expires_at, created_by) — TTL 10 min
- Migration `016_action_chat.sql`

### Model

Default: `deepseek/deepseek-v4-pro` for parity with insights chat. Fallback to `deepseek/deepseek-v4-flash` then `deepseek/deepseek-v3.2` on 429/5xx. **Caveat:** tool-calling reliability on DeepSeek is decent but not Claude-level. If you see misparses in practice, the cheapest fix is to allow Sonnet 4.6 as a third-tier fallback — open question for you below.

### Cost rough order

- Read-only single-tool turn: ~$0.005 (one DeepSeek call, small response).
- Bulk preview + confirm: ~$0.01 (two model calls — one to parse, one to confirm).
- 100 turns/day → ~$1/day.

### Phasing

1. **Phase 1 — Read tools only** (no risk; ship this first to validate UX): `find_leads`, `get_lead`, `count_leads`, `recent_activity`, `export_csv`. Plus the chat tab + sidebar shell.
2. **Phase 2 — Single-lead mutations**: `add_note`, `update_lead_priority` (1 lead at a time), `mark_dead` (1 at a time).
3. **Phase 3 — Bulk mutations**: `move_leads_to_stage` (the big one), `update_lead_owner`, `add_tags`/`remove_tags`, bulk forms of others.
4. **Phase 4 — Compound/chained tools**: filter-then-mutate in one prompt, multi-step plans.

Each phase ships independently; you start using Phase 1 within a day.

## Open questions for you

1. **Tab placement**: new top-level `/actions` nav tab, OR a tab toggle inside `/insights` (so sidebar has Insights / Actions modes)?
2. **Mutation confirmation policy**: A) every mutation requires Confirm click, OR B) single-lead trivial ones (add note, update priority of 1 lead) auto-execute, only bulk and stage changes need confirm?
3. **Bulk safety cap**: at what N does the chat force a "type CONFIRM 27" friction step? My instinct is 25 — too low feels naggy, too high lets a misparse nuke the pipeline. Pick.
4. **Model fallback**: keep DeepSeek-only (matches insights chat), OR allow Sonnet 4.6 as a tier-3 fallback for tool-call reliability (mutations only)? My rec is allow it for mutations specifically — tool-call mistakes here have real cost; Sonnet is much more reliable on multi-tool plans.
5. **Phase 1 scope**: ship just read tools first to validate UX, then add mutations? OR build the whole thing at once and ship together?

Pick those and I'll start building.
