---
title: Resident Dot Model — always-on agents in Kyberion
category: Architecture
tags: [architecture, autonomy, resident-agent, dots, charter, supervision]
importance: 8
author: Ecosystem Architect
last_updated: 2026-10-05
---

# Resident Dot Model

OpenAI "dots" (announced 2026-09-29) are always-on agents inside ChatGPT: each
holds an ongoing responsibility, owns a cloud computer and browser, connects to
apps, delegates heavy work to Codex/Work tasks, and messages the human only
when a decision is needed. This document maps that shape onto Kyberion's
existing primitives and defines the missing piece: the **dot charter**.

## Inactive starter team

For a bounded three-role proposal covering intake, completion coordination,
independent verification, operations triage and knowledge curation, see the
[starter playbook](../orchestration/dot-team-starter-playbook.ja.md). Its three
charter templates are drafts outside resident discovery; they do not activate
workers, add authority, or replace the existing repo-guardian and org-operations
charters. The playbook distinguishes quality acceptance from action approval
and documents the current handoff and executor limitations.

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
   name a cheaper policy action. Then `allowed_work_shapes` (default
   `direct_reply`; `task_session` is refused up-front while no governed
   task-session executor is configured, even when declared), handoff acceptance, and `max_concurrent_delegations`
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

## The closed organization loop (landed MSN-DOT-ORG-LOOP-20261004, DL-01..11)

A wake used to end at "WorkItem created". The loop now closes: work is
executed, measured against key results, judged, remembered, and fed back into
the next wake and the dot's autonomy level.

```
wake ──proposal──▶ dispatch (gate ⊔ floors, arbitration) ──▶ WorkItem
  ▲                                                             │
  │ report-back inbox row / follow-up / event / cron catch-up    ▼
  └──────── outcome verdict ◀── KR re-measure ◀── executor (claim → run → release)
```

- **Executor (DL-01)**: each sweep claims `ready` WorkItems addressed to the dot
  (`metadata.dot_id` or `handoff_to`) under the charter role, runs them by
  shape (`direct_reply` as a bounded text turn, `pipeline` only if listed in
  `authority.allowed_pipelines`, `mission` is escalated). The live
  `task_session` adapter has no governed task tools yet: dispatch refuses the
  shape before asking anyone, and a legacy item is closed as blocked with
  `reason_code: capability_unavailable` and no report-back wake (the dot reads
  it in its work results), so propose → block → wake → re-propose cannot loop.
  A model's declaration of completion is not evidence of an executed task.
  Result evidence, including the pre-work KR snapshot, is persisted before
  releasing the lease. Errors, timeouts and abandoned claims are quarantined
  rather than retried: an abort signal does not prove cancellation, and late
  effects may still occur. The exception is a provably pre-effect failure
  (`DotExecutorPreEffectError`: no backend resolved, pipeline missing or
  invalid, goal driver failing before its first model call), which returns the
  item to `ready` for up to 3 attempts and then ends as an escalated failure.
  Recovery reconciles the original action/attempt without re-executing it.
  Quarantine ends only by a human-approved release:
  `pnpm kyberion dot release <dot_id> <work_item_id> --reason "<text>"` only
  creates a human-only approval request (autonomy channel, shown by
  `pnpm kyberion approvals`, 72 h expiry) describing item, tenant, attempts and
  reason, bound to the item's current version. The executor sweep applies it
  once an authenticated human approved it — never a veto window, agent or
  service; the request tenant must match the item's and the charter's, and the
  item must be unchanged — recording `metadata.dot_executor.operator_verified_*`
  from the approver (not the requester's `--by`), auditing
  `dot_work_item_operator_release`, marking the request applied (or failed with
  the refusal) and returning the item to `ready`; evidence and expired attempts
  older than the release stop blocking, so the next sweep re-attempts it under
  a new attempt id. A plain reopen is still re-archived as
  a conflict. Terminal reports use an idempotent inbox identity plus a durable
  result receipt (`payload.report_from = dot-executor`), so a failed release,
  enqueue or receipt update can be reconciled. Results written before report
  recovery existed (no `report_to_dot_id`) count as reported, so an upgrade
  does not replay historic reports; work results are read once per sweep.
  The shared filesystem lock primitive publishes lock records atomically and
  serializes stale cleanup; an unreadable record or an orphaned cleanup guard
  is reclaimed automatically after 30 s, never a live holder's lock. Restart
  competing workers on upgrade so they all use the repaired primitive in the
  same PID/filesystem namespace.
- **Key results (DL-03)**: `goal.key_results` are measured per sweep
  (`probe`, `file`, `signal_ratio`, `org_metric`) into `kr-ledger.jsonl`; gaps
  to target are injected into the wake prompt. Organization objectives roll up
  from the org-scope ledger.
- **Outcomes (DL-04)**: a proposal's `expected_effect` ({kr_id|signal,
  direction}) is stored on the WorkItem. After the settle window
  (`outcome_settle_minutes`, default 60), a measurement strictly after completion
  and at or after the due time is required before a verdict
  `improved | no_change | regressed | unmeasurable` lands in `outcomes.jsonl`;
  `regressed` feeds execution feedback. Recent verdicts enter the next prompt.
- **Memory (DL-05)**: `memory/<dot>.json` (notes, open items, hypotheses;
  8 KB, deterministic eviction), edited through the `dot_update_memory` tool /
  `dot-memory` fence and distilled weekly. Persisted ID high-water marks survive
  eviction/removal; legacy migration also reads distillation history strictly.
  Already-reused legacy IDs cannot be reliably reconstructed and are not relabeled.
- **Follow-ups and catch-up (DL-09)**: `dot_schedule_followup` / `dot-followup`
  (5 min to 7 days, 3 pending) writes `followups.jsonl`; a due follow-up is a
  `followup:<id>` wake. A follow-up can atomically replace itself at capacity;
  deterministic successors survive failed wake-ledger writes without duplicate
  rearming. If the replacement cannot be persisted, the wake is recorded
  delivered with `trigger_retained: true` (proposals are not re-dispatched)
  and the parent stays pending, re-firing after the failure backoff so the
  chain is not lost. Missed cron minutes within
  `runtime.cron_catch_up_hours` (default 6, max 24) coalesce into one wake.
- **Events (DL-08)**: a charter trigger `{kind: 'event', sources, types?,
match?}` wakes on an authenticated inbound event. The loopback-only
  `event-intake` surface verifies an HMAC-SHA256 signature (secret from the
  secret store), dedups by delivery id and source/payload digest, and appends
  to `events.jsonl`. Unsigned type/delivery headers cannot evade payload dedup;
  that check retains its existing 24-hour, 2,000-row / 4 MiB tail bounds. The
  tenant comes from `event-intake-policy.json`, never the payload. Every
  source ships disabled.
- **Budget governor (DL-07)**: `org-budget-governor` aggregates daily token
  usage per tenant/organization (`spend-policy.json` `org_budget`): `soft`
  (80 %) forces proposals to `approve` (propose-only), `hard` (100 %) stops
  wakes and the executor while housekeeping continues. The cost cap inherits
  `daily_cap_usd`. Trusted per-attempt accounting IDs reconcile SDK token
  evidence with dot-ledger estimates, including late responses; uncorrelated
  legacy rows count conservatively and can overcount same-day overlap. Configured
  cost caps pause on relevant unreadable, unpriced or unscoped cost evidence;
  token-only policies do not pause solely for unknown cost. Historic dot-ledger
  scope still depends on valid, stable charter scope. Unrelated governor exceptions
  retain the existing outer fail-open behavior.
- **Autonomy L0-L4 (DL-10)**: L0 shadow (decisions recorded, nothing acts),
  L1 approve-all, **L2 supervised (default, today's behavior)**, L3 trusted
  (one human approval releases a learned floor; decays in 7 days), L4
  autonomous (policy-listed reversible actions only, outcome success >= 0.8).
  Charter floors and a gate `approve` are never relaxed. Promotion needs 20
  decisions, >= 90 % agreement, >= 80 % outcome success and zero incidents in
  30 days, and is applied only after a human approves the decision card;
  demotion is automatic. The default ceiling is L3 (`autonomy.max_level`).
- **Arbitration (DL-11)**: proposals carry a normalized `target` and `intent`;
  `team.owns` and `team.priority` rank the contenders. A conflicting
  parked/dispatched action of another dot within 6 h is resolved by owner,
  then priority gap >= 10, otherwise merged into one decision card
  (`arbitration.jsonl`; the superseded action is declined as `superseded`
  without raising a learned floor).
- **Cadences (DL-06)**: organization operation tick, standup and retro run as
  pipelines that ship `enabled: false`; hosts opt in per id through
  `KYBERION_CHRONOS_SCHEDULES`.

**State domain**: all loop state lives under `active/shared/runtime/dot/`
(`work-results`, `kr-ledger`, `outcomes`, `outcome-pending`, `followups`,
`events`, `memory/`, `autonomy/`, `arbitration`), addressed only through
`dotStatePath(charter, ...parts)` (`libs/core/dot/dot-state-paths.ts`). An
untenanted dot writes `active/shared/runtime/dot/<file>`; a tenant dot writes
the tenant's physical namespace (`physicalScopedPath`). Tenant prose (memory,
follow-up reasons, event bodies, results) never lands in a system-floor file:
the pre-existing flat ledgers (`dot-wake-ledger`, `dot-action-ledger`,
`dot-inbox`) stay shared, so tenant dots write only category-level text there.
See [runtime-storage-layout](./runtime-storage-layout.md).

**One owner per `dot_id`**: those shared ledgers, the inbox, WorkItems and
approvals are keyed by `dot_id`, so exactly one charter may load per ID
(`listDotCharters`). A repo-level `dots/` charter owns its ID over any tenant
duplicate. A tenant-level ID belongs to the tenant whose charter was
activated first (`dot-lifecycle-audit.jsonl`); it never moves to another
tenant — not while that owner is paused or retired, nor after its file is
removed — so one tenant can neither disable nor inherit another tenant's dot
(the newcomer must pick a new `dot_id`). Without audit history the
earliest-activated established (`active`/`paused`) charter keeps the ID (file
mtime, then path); two charters for one ID in the same scope load neither.
Every rejected charter is a load error that the supervisor sweep warns about
and carries in its heartbeat; `dot validate` fails on it.

The loop is hermetically tested end to end in
`libs/core/dot/dot-loop.integration.test.ts`.

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
