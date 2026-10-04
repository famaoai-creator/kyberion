---
title: Resident Dot Model — always-on agents in Kyberion
category: Architecture
tags: [architecture, autonomy, resident-agent, dots, charter, supervision]
importance: 8
author: Ecosystem Architect
last_updated: 2026-10-04
---

# Resident Dot Model

OpenAI "dots" (announced 2026-09-29) are always-on agents inside ChatGPT: each
holds an ongoing responsibility, owns a cloud computer and browser, connects to
apps, delegates heavy work to Codex/Work tasks, and messages the human only
when a decision is needed. This document maps that shape onto Kyberion's
existing primitives and defines the missing piece: the **dot charter**.

## Element mapping

| OpenAI dot element                     | Kyberion primitive                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| Holds an ongoing responsibility        | `DotCharter` (`dots/`) + `worker-goal-driver` goal loop (KD-01)                         |
| Own computer + browser                 | Local host + browser-actuator / system-actuator (`computer_interaction`)                |
| App connections                        | Actuators + provenance-gated plugins + MCP bridges                                      |
| Delegates heavy work                   | mission_controller / WorkItem + `delegateTask` subagents + multi-provider co-execution  |
| Works between conversations            | `chronos` scheduler + `trigger-runner` (`cron`/`watch`/`wake`)                          |
| Messages you when a decision is needed | proposal → `autonomous-ops-gate` + charter floor → decision card / veto → charter route |
| Specialist identity                    | `dot:<id>` actor on WorkItems, approvals, audit chain; authority = charter role         |
| Teams of dots                          | `team.responsibilities` (exclusive) + `accepts_handoffs_from` handoffs                  |
| Learns from feedback                   | `dot-feedback.jsonl` → learned floors + prompt; `signal_probes` → signal ledger         |
| Persistent memory                      | `knowledge/` tiers + distill → `memory-promote` loop                                    |
| Emergency stop                         | `kill-switch`                                                                           |
| Liveness                               | `daemon-heartbeat` + `daemon_watchdog` + leader lease                                   |

## The charter is the only new contract

Everything else already exists. A charter binds: goal (responsibility),
attention (trigger set), authority (an existing role — never new power),
decision floor (ops-gate), and notification (deliver_to + digest). See
[`dots/README.md`](../../../dots/README.md).

## Runtime wiring (landed MSN-RESIDENT-DOT-RUNTIME-20261002)

1. `agent-runtime-supervisor` multiplexes active charters: a daemon sweep
   (`KYBERION_DOT_SWEEP_INTERVAL_MS`, default 30 s) evaluates each active
   charter's `attention.triggers` via `evaluateDotTriggersDue` and routes due
   wakes through `TriggerRunner` (idempotency + audit + the charter's role as
   the trigger authority, assumed via `withExecutionContextAsync`). The deliver
   handler runs one bounded `worker-goal-driver` turn (`runDotWake`) with the
   charter's budget and `toolRole`.
2. Due-ness memory is `active/shared/runtime/dot-wake-ledger.jsonl`; cron keys
   are `<expr>@<minute>` in the charter timezone, watch keys encode
   `mtime:size` (snapshot in `dot-watch-state.json`), wake keys are inbox-line
   hashes (`dot-inbox.jsonl`). Failed wakes stay retryable; cron does not
   catch up on slept minutes.
3. `goal.budget.token_cap_per_day` is enforced across processes via
   `dot-token-usage.jsonl`; per-wake turns/wall-clock map to
   `GoalBudgetLimits` (KD-02).
4. Status transitions are governed (`libs/core/dot/dot-lifecycle.ts`,
   `kyberion dot activate|pause|retire`): activation requires the authority
   role in the canonical registry and a heartbeat_id that collides with
   neither `DEFAULT_DAEMONS` nor another active dot.
5. The dot's heartbeat (`runtime.heartbeat_id`) joins `daemon_watchdog`'s
   supervised set while active (`listActiveDotHeartbeatIds`), so a silent dot
   pages, same as any daemon.
6. A dot never acts directly: it proposes (MSN-RESIDENT-DOT-AUTONOMY-20261004,
   see "Governed proposals" below).

## Governed proposals (landed MSN-RESIDENT-DOT-AUTONOMY-20261004)

A wake produces **proposals**, not effects: tool-capable backends call
`dot_propose_action`; delegated shell CLIs end their reply with a fenced
`dot-proposals` JSON array (`libs/core/dot/dot-proposals.ts`). The runtime
governs each one in the supervisor process, under the charter role
(`libs/core/dot/dot-dispatch.ts`):

1. **Charter bounds**: the policy action is derived, never chosen by the dot
   (`dot_handoff` with `handoff_to`, else `dot_delegate_work`), so a dot cannot
   name a cheaper policy action. Then `allowed_work_shapes` (default `task_session`,
   `direct_reply`), handoff acceptance, and `max_concurrent_delegations`
   (default 3). Open WorkItems and parked decisions both count toward the cap.
   A tenant-scoped dot also needs its tenant registered and operational, so
   the operator is never asked to approve work that cannot run. Every bound
   except the cap is re-checked when an approved action settles.
2. **Decision**: the `autonomous-ops-gate` verdict is raised to the strictest
   of `decisions.default_decision`, the floor learned from operator
   rejections, and the dot's own `requested_decision`. A charter
   `veto_window_minutes` may lengthen the policy window, never shorten it.
   Both dot actions score notify with a 60-minute policy veto window, so
   they become veto cards. A handoff creates the same ready WorkItem as a
   delegation, so it must never be the cheaper path.
3. **Routing**: `routeAutonomousDecision` handles the decision card, the veto
   window, and the digest notice. It delivers to the charter route:
   `notification.delivery_mode` is `inbox` by default, and only `live` sends
   to `deliver_to`. Quiet hours defer delivery to the inbox. A veto card
   delivered to the inbox never starts its clock, so it falls back to a human
   decision. Silence counts as consent only when the operator could actually
   hear it. Waiting decisions count toward `max_concurrent_delegations`, so a
   dot pauses proposing while that many wait — until a decision waits past
   `decisions.decision_expiry_minutes` (default 24 h) or its own request
   expiry. The charter expiry never cuts a live veto window short; it
   applies once the card has no window or has fallen back to a human
   decision. Then settlement expires the request and declines the action as
   `expired`. That frees the slot, and expiry does not raise the learned
   floor (an unattended inbox is not a rejection). Message content stays local by
   default; devices subscribed to Web Push still get a content-free wake-up.
4. **Outcome**: proceed creates a `ready` WorkItem. Parked decisions are
   settled each sweep (`settleDotParkedActions`): approved runs after the
   charter scope is re-checked (it may have narrowed while it waited);
   anything else is declined, and a declined proposal is not re-asked for
   24 hours. Settlement is idempotent across a crash (one feedback row per
   action, an existing WorkItem for the `action_ref` is reused), and a
   transient approval-store read failure leaves the action parked. The
   supervisor also ticks autonomy veto windows each sweep.

**Identity**: every effect carries `dot:<dot_id>`. It appears in WorkItem
metadata, as the approval requester, as the audit-chain `agentId`/`actor`,
and in notification titles. The wake ledger keeps a bounded `summary` of the
dot's own words (proposal block removed), shown as "last said" in
`dot status`, so a wake that proposed nothing still explains itself. The
ledger is a shared system-floor file, so tenant-scoped dots never write a
summary. A dot's
authority is still exactly its role.
Per-dot secret scoping beyond the role is not implemented.

**Teams**: `team.responsibilities` are exclusive; activation is refused
while another active dot holds the same key. A handoff creates a WorkItem and
an inbox row `{dot_id: target, payload.handoff_from}`. That row wakes the
target only if the target's `team.accepts_handoffs_from` lists the sender,
even when the target declares no wake trigger.

**Learning**: settled decisions land in `dot-feedback.jsonl`. A rejection
raises the dot's floor (dot-wide, so re-labelling the work cannot escape it)
to `approve` until 3 approvals with `decidedByType: human` follow;
veto-window silence and agent or service deciders do not count. Feedback
older than 30 days expires, so an old rejection stops holding the floor. It also feeds the execution-feedback
store, so distill can propose a reviewed improvement. Recent feedback and
`goal.signal_probes` measurements (`dot-signal-ledger.jsonl`) are injected
into the next wake prompt and the `digest_cron` digest, and are shown in
`kyberion dot status`.

## Hard-won constraint from MSN-RESIDENT-DOT-20261002

The autonomy substrate only works if the _alert path itself_ is authorized:
`daemon_watchdog` and `chronos_gateway` previously lacked `ops-alerts.jsonl`
write scope, so the watchdog died exactly when it had something to report and
the hourly health watch could not escalate. Any dot runtime must land its
authority role in `security-policy.json` **before** activation — the schema
cannot express that, so `status: active` transitions are gated by
`dot-lifecycle.ts` (`transitionDotCharterStatus`), which validates role
existence and heartbeat uniqueness.

## Locality caveat

Dots run in OpenAI's cloud; Kyberion dots run on this host. macOS sleep stops
chronos and every resident loop. `decisions.quiet_hours` and
`autonomous-ops-policy.active_hours` are the sanctioned way to bound that;
true 24/7 operation needs a non-sleeping host (customer VM per
docs/operator/DEPLOYMENT.md "persistent always-on" section).
