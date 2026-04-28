---
title: AI-Run Meetings Use Case
category: Architecture
tags: [meeting, facilitation, action-items, voice, use-case]
importance: 8
last_updated: 2026-04-27
---

# AI-Run Meetings — Use Case

A Kyberion deployment can stand in for the operator inside an online
meeting (Zoom / Teams / Google Meet), facilitate the conversation,
extract action items, complete its own slice autonomously, and track
the rest until completion. This document describes the user-visible
flow, the actuators / pipelines that compose it, and the operational
guardrails.

## 1. Operator experience

```
operator $ pnpm meeting:run \
  --mission MSN-MTG-2026-Q2-WEEKLY \
  --meeting-url "https://example.zoom.us/j/9999999999" \
  --platform zoom \
  --persona "Operator" \
  --listen-sec 1800 \
  --agenda "Status|Risks|Action items" \
  --attendees @attendees.json \
  --language ja
```

The orchestrator drives three logical stages:

1. **Facilitate** — opens the agenda, joins the meeting, listens,
   extracts action items into the mission's append-only store.
2. **Execute self** — for each item where `assignee.kind = operator_self`,
   the agent dispatches a small task plan via `delegateTask` and marks
   the item completed (or blocked, with the failure reason).
3. **Track others** — for each `team_member` item, the agent generates
   a per-recipient reminder message, records it on the action item,
   and emits a `meeting.<verb>` audit event.

After every run, a summary is printed:

```
📋 Mission MSN-MTG-2026-Q2-WEEKLY action-item summary:
   total recorded: 7
   operator_self pending: 0
   team_member pending: 4
   🟢 [completed] AI-MTG-1-M1: Send revised proposal to compliance (assignee=Operator)
   🟡 [pending]   AI-MTG-2-M2: Confirm Q3 budget with finance (assignee=Alice)
   ...
```

## 2. Architecture

```
┌─ scripts/meeting_orchestrator.ts ─────────────────────────────────┐
│                                                                  │
│   Stage 1: Facilitate                                            │
│   ─────────────────────                                          │
│   pipelines/meeting-facilitation-workflow.json                   │
│     • meeting-actuator (join → listen → leave)                   │
│     • wisdom:generate_facilitation_script                        │
│     • wisdom:extract_action_items  ── action-item-store          │
│                                                                  │
│   Stage 2: Execute Self                                          │
│   ─────────────────────                                          │
│   pipelines/action-item-execute-self.json                        │
│     • wisdom:execute_self_action_items                           │
│         (for each operator_self item:                            │
│            in_progress → delegateTask → completed | blocked)     │
│                                                                  │
│   Stage 3: Track Others                                          │
│   ──────────────────────                                         │
│   pipelines/action-item-tracking.json                            │
│     • wisdom:track_pending_action_items                          │
│         (for each team_member item: generate reminder → log)     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### New components introduced

| Component | Purpose |
|---|---|
| `schemas/action-item.schema.json` | Canonical action-item shape (used by validators and AJV-based contract checks) |
| `libs/core/action-item-store.ts` | Append-only JSONL store (`action-items.jsonl`) under the mission's evidence directory; provides `recordActionItem`, `updateActionItemStatus`, `appendReminder`, `listActionItems`, `listOperatorSelfPending`, `listOthersPending` |
| `wisdom:extract_action_items` | LLM-driven transcript → structured items + persistence |
| `wisdom:generate_facilitation_script` | Short utterances for opening / transition / wrap-up |
| `wisdom:generate_reminder_message` | Per-item reminder draft (channel + text) |
| `wisdom:execute_self_action_items` | Iterate `operator_self` pending items; dispatch via `delegateTask`; transition to completed / blocked |
| `wisdom:track_pending_action_items` | Iterate `team_member` pending items; emit reminders; record into the store |
| `meeting-actuator` (existing, hardened) | `join / leave / speak / listen / chat / status` with **voice consent gate** on `speak` and `meeting.<verb>` audit emission |
| `pipelines/meeting-facilitation-workflow.json` | Stage 1 wiring |
| `pipelines/action-item-execute-self.json` | Stage 2 wiring |
| `pipelines/action-item-tracking.json` | Stage 3 wiring (cron-able) |
| `scripts/meeting_orchestrator.ts` | Stage runner + summary |

## 3. Guardrails

The use case implies authority that the operator must explicitly delegate:

- **Voice consent (`meeting-actuator`)** — `speak()` is refused unless
  the active mission's evidence directory contains a `voice-consent.json`
  whose `consent: 'granted'` is unambiguous. Without that file, the
  agent can `join`, `listen`, `chat`, and `leave`, but cannot speak in
  the operator's voice. This is the load-bearing check; never bypass.
- **Voice profile registration** — the synthesized voice itself must be
  a `voice-profile-registry.json` entry whose source samples were
  recorded by the operator (see `pipelines/voice-recording-session.json`).
  A clone made from samples that do not belong to the operator is a
  separate, refused workflow.
- **Action items are reminders, not authority** — items assigned to
  others surface a reminder, never an instruction. Recipients keep
  agency.
- **Audit emission** — every `join / leave / speak / listen / chat`
  call lands as a `meeting.<verb>` audit event with the redacted
  meeting target, platform, duration / character count, and
  `tenant_slug` when applicable.
- **Tenant scope** — when `KYBERION_TENANT` is set on the orchestrator,
  the mission inherits it; per-tenant SIEMs receive only their own
  meeting events via `TenantFilteringAuditForwarder`.

## 4. Failure modes

| Failure | Detection | Response |
|---|---|---|
| Voice consent missing on `speak` | Returns `status: denied`; emits `meeting.speak_denied` | Operator records consent; rerun |
| Bridge cannot join the meeting | Returns `status: error`; emits `meeting.join_failed` | Investigate bridge / platform; rerun with `--skip-facilitate` after manual join |
| LLM extracts zero action items | `action_item_count = 0` in pipeline ctx; orchestrator summary shows total=0 | Re-run with longer `listen_duration_sec`; verify the transcript file is non-empty |
| `delegateTask` fails on a self item | Item transitions to `blocked` with the error in `result_summary` | Operator unblocks manually or re-runs `pipelines/action-item-execute-self.json` |
| Reminder dispatch sends duplicates | `appendReminder` is idempotent on `(sent_at, channel)` | No remediation needed |

## 5. Cron / scheduling

Stage 3 (tracking) is the obvious cron candidate:

```
# /etc/cron.d/kyberion-meeting-tracking — daily at 09:00 JST
0 0 * * * kyberion cd /opt/kyberion && \
  pnpm pipeline --input pipelines/action-item-tracking.json \
    --context '{"mission_id":"MSN-MTG-2026-Q2-WEEKLY","tone":"friendly","language":"ja"}'
```

Stage 1 is operator-triggered (a meeting is happening *now*). Stage 2
runs immediately after Stage 1 inside `meeting_orchestrator.ts` so the
operator's slice is dispatched while the context is fresh.

## 6. Testing

Unit / contract tests:

- `libs/core/action-item-store.test.ts` (8 cases) — record / update /
  reminders / list filters
- `libs/actuators/meeting-actuator/src/index.test.ts` (9 cases) —
  schema + voice-consent gate
- `libs/actuators/wisdom-actuator/src/decision-ops.test.ts` —
  rubric / convergence (existing suites; the LLM-dependent
  meeting-facilitation ops are integration-tested via the orchestrator
  smoke run when a real backend is configured)

Smoke run (with `claude-cli` backend):

```bash
KYBERION_REASONING_BACKEND=claude-cli \
  pnpm meeting:run \
    --mission MSN-DRY-RUN-001 \
    --meeting-url "https://example.zoom.us/j/9999999999" \
    --platform auto \
    --listen-sec 5 \
    --skip-tracking
```

## 7. Reference

- [`schemas/action-item.schema.json`](../../../schemas/action-item.schema.json)
- [`libs/core/action-item-store.ts`](../../../libs/core/action-item-store.ts)
- [`libs/actuators/meeting-actuator/`](../../../libs/actuators/meeting-actuator/)
- [`pipelines/meeting-facilitation-workflow.json`](../../../pipelines/meeting-facilitation-workflow.json)
- [`pipelines/action-item-execute-self.json`](../../../pipelines/action-item-execute-self.json)
- [`pipelines/action-item-tracking.json`](../../../pipelines/action-item-tracking.json)
- [`scripts/meeting_orchestrator.ts`](../../../scripts/meeting_orchestrator.ts)
- [`knowledge/agents/meeting-proxy.agent.md`](../agents/meeting-proxy.agent.md) — agent template
- [`kyberion-intent-catalog.md`](./kyberion-intent-catalog.md) §3.6 — adjacent platform-extension intents
