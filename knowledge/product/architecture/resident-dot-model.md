---
title: Resident Dot Model — always-on agents in Kyberion
category: Architecture
tags: [architecture, autonomy, resident-agent, dots, charter, supervision]
importance: 8
author: Ecosystem Architect
last_updated: 2026-11-19
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
charters. The org-operations charter itself ships only as a tenant-free draft
template next to them and is instantiated per tenant organization into
`knowledge/confidential/<tenant>/dots/`. The playbook distinguishes quality acceptance from action approval
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
   hashes (`dot-inbox.jsonl`). Failed wakes stay retryable. Missed cron minutes
   coalesce within `runtime.cron_catch_up_hours` (default 6, maximum 24);
   this bounded catch-up does not replay the entire downtime history.
3. `goal.budget.token_cap_per_day` is enforced across processes via
   `dot-token-usage.jsonl`; per-wake turns/wall-clock map to
   `GoalBudgetLimits` (KD-02). A wake is an event-handler goal, not the
   standing goal: its objective is "handle this trigger against the standing
   goal" (the charter system prompt is sent once, as `systemPrompt`), the goal
   driver runs it with `completionMode: 'event_handler'` (complete as soon as
   the trigger is handled or needs nothing, instead of the strict
   anti-early-completion audit) and `budgetGraceStep: false` (no extra
   prose-only turn at the cap). `max_turns_per_wake` stays the hard cap.
   A wall-clock overrun during which the process did not run for more than
   30 s (host asleep, e.g. a macOS DarkWake that slept again) is recorded as
   `skipped` with `reason_code: host_suspended`, not `failed`: the trigger is
   not consumed and the failure circuit and backoff ignore it
   (`dot-wake-suspension.ts`, a timer-gap monitor — on Node 24/darwin
   `hrtime`/`performance.now` keep counting across sleep, so a clock delta
   cannot see it). A claimed durable event attempt stays a failure.
4. Idle cron wakes skip the model (`dotCronWakeIdleReason`): a cron wake whose
   last real wake was delivered and that sees no due inbox row, pending
   watched-file change, due follow-up, outcome continuation, new
   `dot-feedback` row or approval decision on this dot's requests since then is
   recorded `delivered` with `idle_skip: true`, `turns_run: 0` (the cron key
   and catch-up treat it as handled; the heartbeat is still written). At least
   every `runtime.force_wake_every_ms` (default 6 h; distinct from the
   watchdog bound `max_idle_wake_ms`) a real wake runs. Any unreadable signal
   means wake.
5. Status transitions are governed (`libs/core/dot/dot-lifecycle.ts`,
   `kyberion dot activate|pause|retire`): activation requires the authority
   role in the canonical registry and a heartbeat_id that collides with
   neither `DEFAULT_DAEMONS` nor another active dot.
6. The dot's heartbeat (`runtime.heartbeat_id`) joins `daemon_watchdog`'s
   supervised set while active (`listActiveDotHeartbeatIds`), so a silent dot
   pages, same as any daemon.
7. A dot never acts directly: it proposes (MSN-RESIDENT-DOT-AUTONOMY-20261004,
   see "Governed proposals" below).
8. Tenant dots reason through a claimed-task credential binding, never the
   operator's credentials (MSN-DOT-STANDING-BINDING-20261116,
   `libs/core/dot/dot-standing-binding.ts`). Each tenant dot has one standing
   Issue on the deterministic `MSN-DOT-*` lineage (the mission-admission id
   rule applied to `dot-standing:<tenant>:<dot_id>`); every wake and every
   executor item is one claim (one attempt) on a reusable child step per kind,
   held by the dot's canonical NHI with its lease renewed by the supervisor
   for the run, so a dot owns at most three WorkItems. Only charters loaded
   from `knowledge/confidential/<tenant>/dots/` bind that tenant's
   credentials; a repo-level charter declaring a tenant fails closed. The binding is minted
   from that live claim by `withConfiguredTaskCredentials`; the provider
   credential still comes only from the tenant owner's `credential.use`
   standing grant, re-validated at every use. The standing claim is not
   authority: the charter grants nothing, and proposals still become separate
   WorkItems. A missing or expired grant fails the wake with
   `[DOT_CREDENTIAL_GRANT_MISSING]` / `[DOT_CREDENTIAL_GRANT_EXPIRED]` (no
   model call). One `credential_grant` failure opens the dot's wake circuit at
   once: wakes are held for 24 h (`DOT_WAKE_CREDENTIAL_RECHECK_MS`) or until
   the tenant's `credential.use` grant records or the charter's routed backend
   change (fingerprint kept in the tenant-scoped `wake-circuit/` marker), with
   one ops alert per opening and no ledger row per held sweep. Tenantless dots are unchanged. Grant
   extension and the expiry reminder:
   [tenant-task-credential-binding](../orchestration/tenant-task-credential-binding.ja.md#常駐-dot-の-bindingstanding-lineage).

## Proactive signal alerts

A person can keep one conversational point of contact while work uses the
[actor and responsibility model](./actor-identity-and-responsibility-model.md)
and [mission team contracts](./mission-team-composition-model.md). A conversation
can hand off an intent reference to a Mission. WorkItems and execution attempts
carry their own admitted scope and recipient-specific Context Packs. Changing
Stance affects new selections. An existing WorkItem keeps the scope in its
contract. Approved decisions, evidence, and artifacts retain their owners and
versions. Display surfaces resolve viewer access again when showing a result.

To notify a person before they ask, a resident Dot can opt into
`notification.signal_alerts: { max_age_s: 14400 }`. It reuses its measured
`goal.signal_probes`, with the first alert source limited to file probes for an
expected state. The eligible files are public knowledge, the Dot's own runtime
subtree, and tenant or organization knowledge matching the charter. An org-less
tenant uses its tenant scope. Personal alerts are scoped to the owner's NHI,
and public alerts use public sources or their own runtime subtree.

Each observation identifies the Dot, scope, signal, probe revision, time, and
health. The supervisor stores the active episode in the corresponding Dot
state partition. Probe records for an opted-in charter also use that partition.
A new unhealthy episode opens a pending alert with a fixed expiry. Publication
requires another current unhealthy observation if quiet hours deferred the
first one. The supervisor also re-reads the eligible source immediately before
enqueue. A healthy observation closes the episode, and an expired episode
cannot be published using its expired evidence. If no delivery was attempted,
a newer unhealthy observation after quiet hours can renew the evidence window.
An attempted delivery retains its original identity and expiry. Unavailable
observations do not authorize an alert.
After an interrupted enqueue, a still-fresh pending episode can replay the
same unhealthy observation. Publication rechecks the source and quiet hours,
and reuses the original inbox ID.

When the source still fails the probe, the Dot prepares the first inbox entry
from that confirmation. It records the scoped source path, confirmation time,
whether the file is missing or fails the expected state, and a suggested
operator check. It excludes the file contents and matching expression. The
episode retains its prepared evidence before enqueue, so retries reuse the
same text even if a later recheck observes a different failure. Preparation
uses the existing probe read and inbox delivery scope. Any subsequent action
uses the existing Dot authority and approval rules.

Proactive preparation starts with the observations declared in
`goal.signal_probes`. The charter's `notification.signal_alerts` controls
triage, from recording a proposed route in `shadow` to preparing follow-up
options in `prepare`. Routing feedback follows the human approval flow
described below.

A charter can opt into `signal_alerts.mode` and declare `digest_signals` by
signal name. A scheduled digest is required when the list is nonempty. A
configured signal keeps immediate delivery if there is no later eligible
digest minute before expiry.

| Mode      | Behavior                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `shadow`  | Records the proposed and applied routes. Keeps immediate inbox delivery.                                                                    |
| `triage`  | Routes the declared subset into the existing digest after confirming it is still unhealthy and fresh. Other alerts keep immediate delivery. |
| `prepare` | Applies the same routing and adds bounded, deterministic follow-up options to immediate alerts.                                             |

`pnpm kyberion dot status <dot-id> --json` includes `signal_triage` for these modes.
It shows the latest retained episode per declared probe, including proposed and
applied routes, the reason, confirmation time, and expiry. In prepare mode an
optional `corroboration: { dot_id, signal }` adds a fresh related observation
from a declared handoff peer with exactly matching custody and work binding.
A peer observation only supplements an independently confirmed local alert.
A recorded route is fixed for its episode. Changing modes affects subsequent
episodes while existing deferred entries continue to use their original digest
lane while the digest remains configured and the observation is fresh. Digest
admission reserves each episode ID before delivery and preserves the original
snapshot for a retry. Before retrying, the sender rechecks the included
episodes. If any is no longer eligible, it suppresses that frozen snapshot.
Revoking or changing the applicable notification
configuration prevents delivery of the stale snapshot. The episode is scoped
to the charter. Existing unconfigured alert behavior is preserved.

### Directed preparation and feedback

A prepare-mode Dot can opt into `directed_intent: true`. An operator can ask
it to check a declared file sooner through the existing addressed inbox lane.

```sh
pnpm kyberion dot inbox append --channel inbox --dot-id <dot-id> --prepare-signal "<signal>"
```

The Dot requires a fresh addressed inbox row in its own custody and a wake
channel it has accepted. It matches only the exact declared signal and verifies
the file independently before alerting. Message text adds no fetch authority.

When an operator concludes a recurring signal belongs in the digest, they can
submit that feedback as a scoped review request.

```sh
pnpm kyberion dot inbox request-digest <dot-id> "<signal>" "<reason>"
pnpm kyberion approvals --approve <request-id>
```

After approval, set `signal_alerts.ratified_digest: { signal, approval_id }` on the
charter. Authorized human approval, exact scope, probe, schedule and
destination are verified before applying the preference to new episodes.
Revocation prevents new uses and prevents a queued digest from retrying a
snapshot that depended on the revoked preference. The existing authority and
approval requirements for work execution still apply.

Before writing an inbox entry the supervisor rereads the active charter and
checks the tenant's operational status. A scope, role, route policy or probe
change invalidates a pending observation from the previous configuration.
The inbox entry retains the source scope and a stable episode ID for retries.
This path publishes to the scoped local inbox. Inbox readers apply viewer
authorization, with owner-bound access for personal entries. It runs the
notification lifecycle separately from external actions and human approvals.

## Governed proposals (landed MSN-RESIDENT-DOT-AUTONOMY-20261004)

A wake produces **proposals**, not effects: tool-capable backends call
`dot_propose_action`; delegated shell CLIs end their reply with a fenced
`dot-proposals` JSON array (`libs/core/dot/dot-proposals.ts`). The runtime
governs each one in the supervisor process, under the charter role
(`libs/core/dot/dot-dispatch.ts`):

1. **Charter bounds**: the policy action is derived, never chosen by the dot
   (`dot_handoff` with `handoff_to`, else `dot_delegate_work`), so a dot cannot
   name a cheaper policy action. Then `allowed_execution_shapes` (default
   `direct_reply`; `task_session` is refused up-front while no governed
   task-session executor is configured, even when declared), handoff acceptance, and `max_concurrent_delegations`
   (default 3). Open WorkItems and parked decisions both count toward the cap.
   A tenant-scoped dot also needs its tenant registered and operational, so
   the operator is never asked to approve work that cannot run. A dot never
   reads utterances, so its proposed `execution_shape` is turned into the
   shared `RoutingDecision` for that charter-bounded shape
   (`libs/core/dot/dot-routing-decision.ts`); work the work-scope policy would
   route to another shape is refused and re-proposed. Every bound except the
   cap is re-checked when an approved action settles.
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
   charter scope, current authority, policy gate and shadow disposition are
   re-checked (they may have changed while it waited). An unchanged usable
   approval resumes without another decision card;
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
ledger is a shared system-floor file, so tenant and personal dots keep prose
in their scoped state and never copy it into the shared summary. A dot's
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
  `task_session` adapter has no governed task tools yet. New proposals are
  refused unless a governed task-session executor is configured. The live
  step port can run an existing `task_session` as bounded advisory goal turns
  when the charter explicitly allows that shape and a backend resolves;
  otherwise it is closed as blocked with `reason_code: capability_unavailable`
  and no report-back wake. Advisory completion is not evidence that task
  tools ran. See [dot-initiated-workflow](./dot-initiated-workflow.md).
  A model's declaration of completion is not evidence of an executed task.
  Result evidence, including the pre-work KR snapshot, is persisted before
  releasing the lease. Errors, timeouts and abandoned claims are quarantined
  rather than retried: an abort signal does not prove cancellation, and late
  effects may still occur. The exception is a provably pre-effect failure
  (`DotExecutorPreEffectError`: no backend resolved, pipeline missing or
  invalid, goal driver failing before its first model call), which returns the
  item to `ready` for up to 3 attempts and then ends as an escalated failure.
  Recovery reconciles the original action/attempt without re-executing it.
  Read-only execution evidence is available through `pnpm kyberion dot status <dot_id>`
  (or `--json`, under `sections.executor.execution`). It distinguishes a normal
  running owner, a retained effect hold, an exact-scope target conflict, queued
  work, and unknown evidence. Current, latest-recorded, and held attempt IDs are
  separate: a finalized item may have no current pointer while its old effect
  ownership remains. Ages describe persisted evidence, not a stale-execution
  threshold. An operator must verify the execution stopped and reconcile partial
  or late effects before using the existing human recovery flow.

  The same view reads the scheduling cursor without acquiring a lock. Missing
  cursor means initial order; an invalid truthy JSON shape blocks normal sweeps;
  malformed JSON, unreadable evidence, or a falsy JSON value means continuation
  is unknown (the existing optional scheduler reader may default to initial
  order). No cursor is reset, repaired or advanced. Valid format does not prove
  executor liveness. Missing or malformed WorkItem inventories remain unknown;
  older result rows are labeled historical and cannot establish current health.
  Item references are projected only after exact typed tenant and organization
  matches. The view does not infer missions from labels or claim that approvals,
  budgets, dependencies, or ownership outside the visible scope are clear.

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
  Settled outcomes also form a runtime-only `outcome` wake, even for a dot
  without an inbox trigger. One wake coalesces the eligible ledger prefix:
  its key hashes scope, dot and the append-ordered, unique action identities.
  Delivery uses the normal wake ledger, backoff, circuit, authority and budget
  checks; a result appended during a wake remains due under a new key. No
  tenant metric prose is copied into shared wake details. First valid verdict
  per action is immutable; duplicates do not cause new wakes. Future-dated,
  unsettled or malformed evidence is excluded; clock-skewed evidence becoming
  valid advances the key even when it precedes the last appended result.
  Progress context and `dot status` distinguish `progressing`, `satisfied`,
  `observing`, `replan` and `measurement_needed`. Within a 30-day window,
  two consecutive non-improving outcomes on the same KR/signal request a new
  hypothesis, tool or decomposition on the next wake. Streaks use measurement
  order (append order breaks ties), reset on improvement, and exclude already
  satisfied KR targets. Unknown measurements request measurement repair rather
  than inferring success. These are planning instructions, not new execution
  privileges or a deterministic guarantee that the model changes its plan.
- **Memory (DL-05)**: `memory/<dot>.json` (notes, open items, hypotheses;
  8 KB, deterministic eviction), edited through the `dot_update_memory` tool /
  `dot-memory` fence and distilled weekly. Persisted ID high-water marks survive
  eviction/removal; legacy migration also reads distillation history strictly.
  Already-reused legacy IDs cannot be reliably reconstructed and are not relabeled.
  A hypothesis resolves `confirmed`, `refuted` or `dismissed` (stale/moot; never
  distilled). The prompt renders only the newest 8 open hypotheses plus a count
  of the omitted ones.
- **Follow-ups and catch-up (DL-09)**: `dot_schedule_followup` / `dot-followup`
  (5 min to 7 days, 3 pending) writes `followups.jsonl`; a due follow-up is a
  `followup:<id>` wake. A follow-up can atomically replace itself at capacity;
  deterministic successors survive failed wake-ledger writes without duplicate
  rearming. If the replacement cannot be persisted, the wake is recorded
  delivered with `trigger_retained: true` (proposals are not re-dispatched)
  and the parent stays pending, re-firing after the failure backoff so the
  chain is not lost. Recovery persists the frozen successor without re-running
  the model or proposals, and preserves its original due time. Historical
  retained deliveries without that successor evidence stay pending for
  reconciliation; the runtime does not invent a replacement or replay effects.
  Missed cron minutes within
  `runtime.cron_catch_up_hours` (default 6, max 24) coalesce into one wake.
- **Watches**: a charter trigger `{kind: 'watch', paths, ignore_jsonl_kinds?, min_severity?}`
  wakes when a watched path's `mtime:size` stat diverges from the dot's
  snapshot in `dot-watch-state.json`. `ignore_jsonl_kinds` lists `.jsonl`
  record `kind` values that never fire the watch by themselves: when every
  record appended since the snapshot parses cleanly and carries an ignored
  kind, the snapshot advances silently (the appended range is read with a
  bounded range read). `min_severity` (`info` < `warning` < `critical`)
  skips records whose `severity` ranks lower the same way, so a dot can wake
  at once on critical alerts and leave warnings to its next cron wake; a
  record with no severity still fires. Any malformed, blank or non-ignored line fails open
  and the watch fires. This is how a dot watching `ops-alerts.jsonl` avoids
  re-waking on the `operator_notification_undelivered` rows its own failed
  notifies keep appending — an alert log is a lawful watch path, but a dot
  must not amplify the rows it produces. For an append-only `.jsonl` watch the
  wake detail carries the appended records that were not skipped, compacted to
  timestamp / severity / kind / title / `dedupe_key` / ~200 chars of
  recommendation or context, newest first kept, capped at 1500 characters.
- **Events (DL-08)**: a charter trigger `{kind: 'event', sources, types?,
match?}` wakes on an authenticated inbound event. The loopback-only
  `event-intake` surface verifies an HMAC-SHA256 signature (secret from the
  secret store), dedups by delivery id and source/payload digest, and appends
  to `events.jsonl`. Unsigned type/delivery headers cannot evade payload dedup;
  that check retains its existing 24-hour, 2,000-row / 4 MiB tail bounds. The
  tenant comes from `event-intake-policy.json`, never the payload. Every
  source ships disabled.
- **Pull feeds (DL-12)**: a source that cannot push (Slack keyword search, a
  ticket query) is declared as `{kind: 'feed'}`. The supervisor polls the
  read-only service preset on a bounded cadence, keeps a durable cursor and a
  bounded seen ring under `feed/<specId>.json`, and ingests new items as normal
  intake events — the matching `event` trigger wakes the dot. A feed never wakes
  a dot by itself, refuses a source bound to another tenant, baselines the first
  poll, and reports stalled coverage through `pnpm kyberion dot intake`. See
  [event-feed-intake](./event-feed-intake.md).
- **Budget governor (DL-07)**: `org-budget-governor` aggregates daily token
  usage per tenant/organization (`spend-policy.json` `org_budget`): `soft`
  (80 %) forces proposals to `approve` (propose-only), `hard` (100 %) stops
  wakes and the executor while housekeeping continues. The cost cap inherits
  `daily_cap_usd`. Trusted per-attempt accounting IDs reconcile SDK token
  evidence with dot-ledger estimates, including late responses; uncorrelated
  legacy rows count conservatively and can overcount same-day overlap. Configured
  cost caps pause on relevant unreadable, unpriced or unscoped cost evidence;
  a row whose billing mode is unrecorded (provider CLIs) but that carries a
  provider-reported or registry reference cost counts that reference as an
  upper-bound spend instead of pausing, and a call aborted before any usage
  report marks cost partial (its tokens still count via the dot ledger). Token-only policies do not pause solely for unknown cost. Historic dot-ledger
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

**State domain**: scoped loop payloads live under `active/shared/runtime/dot/`
(`work-results`, `kr-ledger`, `outcomes`, `outcome-pending`, `followups`,
`events`, `memory/`, `autonomy/`, `arbitration`), addressed only through
`dotStatePath(charter, ...parts)` (`libs/core/dot/dot-state-paths.ts`). The
partition is `<tier>/<tenant-or-shared>/`, followed by any organization/project
segments. Personal state additionally uses `owners/<owner-hash>/` before those
entity segments; a tenantless public Dot uses `public/shared/`. Tenant and
personal prose (memory, follow-up reasons, event bodies, results) never lands
in a system-floor file:
the pre-existing flat ledgers (`dot-wake-ledger`, `dot-action-ledger`,
`dot-inbox`) stay shared, so private Dots write only category-level text there.
See [runtime-storage-layout](./runtime-storage-layout.md).

### Personal custody and normal-path continuity

System work belongs to the installation rather than a tenant or person. It
needs its ordinary role and WorkItem claim, but no invented tenant or personal
owner. A server-resolved system selection can admit these ownerless records;
that selection never admits personal records or unknown legacy Dot custody.
The execution actor and lease holder identify who runs the work, not who owns
its data. Data tier remains a separate restriction from both of those axes.

Personal charters use `knowledge/personal/dots/<owner-hash>/` and require
`scope.owner_nhi`. Their runtime state uses the same storage-layout resolver
with the owner's partition. Notification content, recovery receipts and
distilled hypotheses retain the original tier and owner; absence of tenant
does not make personal content a system notification. Viewer admission needs
the authenticated owner and personal tier access. Confidential notifications
retain tenant, organization and project as well.

The default inbox, quiet-hours deferral and stable retry identity remain the
normal route. Scoped storage is not another approval ceremony. Private memory
keeps the actual lesson and provenance in a same-scope feedback/candidate;
the shared ledgers receive no private hypothesis text. Knowledge review and
promotion retain their existing separate authority.

Personal outcomes continue to inform their scoped Dot memory and results;
they do not feed the tenant-only global action-policy learner, whose contract
cannot represent a personal owner. This does not stop authorized personal work.

Private WorkItems are shared routing indexes, with category text and a binding
to the original scoped admission. Their executable title, objective and other
private proposal content stay in the existing action ledger. Execution restores
only the hash-bound original under the same scope and current authority; a
missing or changed source is held before effects. HTTP lists, counts and workspace
graphs also apply custody and tier checks, including old known Dot rows whose
private/public classification cannot be established. They do not reinterpret
unclassified legacy work as installation-wide public work.

The public front-desk diagnostic receipt uses its existing signed request and
approval binding instead of generic admission. Its shared WorkItem contains only
the fixed reference projection from `frontDeskExecutionProposal`: request IDs,
revisions and digests, with no caller prose or charter name. This exception does
not admit confidential or personal input, relax binding checks, or authorize
arbitrary tenant work.

Approved work is rechecked against current scope, role, policy and shadow
disposition before it becomes executable. An unchanged usable approval resumes
automatically; changing owner or scope does not transfer old work. Only a
genuinely absent initial autonomy record uses defaults. A damaged existing
record holds authority rather than restoring a more permissive level.

**Action ledger versions**: rows and admitted proposals are hash-bound, so the
ledger is versioned instead of rewritten (`libs/core/dot/dot-action-ledger-version.ts`).
New rows carry `schema_version: 2` and `execution_shape`; rows written before
the rename (no `schema_version`, `work_shape`) are read through a mapping and
verified in the form they were written. A status change of an old admitted
action is written in the old version, so a row and its admitted proposal are
always compared like-for-like. Dot WorkItems carry `requested_execution_shape`
(items created from old actions keep `requested_work_shape`; readers accept
both for one release).

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

## Forward-only event continuation

Legacy event intake inspects only the latest 2,000 accepted rows / 4 MiB and uses
a 24-hour initial lookback. The dot status command now reports scan coverage;
history outside that window is not an exact lost-event or pending count.

To adopt durable forward continuation, an operator must first pause the charter,
stop all supervisors and competing charter editors, and review existing effects.
Then run: pnpm kyberion dot event continue <dot_id> --confirm-quiescent.
The command preserves draft/paused status and captures the current complete-line
EOF under the intake lock. It writes the continuation snapshot before declaring
the activation ID in the charter. Review dot status and separately use the
normal activation ceremony. This is not historical recovery: rows before the
captured boundary remain untouched.

Per-scope snapshots under the existing dot state floor retain at most 128 matching
pending events; each scan reads a batch of at most 4 MiB, plus fixed-size
256-byte checkpoint-anchor reads, and inspects at most 2,000 lines per sweep.
Capacity stops scanning and never evicts pending work. Offsets advance only with
atomically persisted pending entries; merely offering a wake never acknowledges
it. Scope identity includes tier, tenant, organization, project and dot ID, while
the authenticated event source remains tenant-wide.

A claim is persisted before provider invocation. A crash, timeout, non-complete
goal result, or unresolved output after dispatch retains an ambiguous attempt.
There is no automatic lease expiry or re-dispatch. Known failures before dispatch
retain normal backoff. Matching terminal wake evidence consumes the event; an
authoritative terminal runner record can reconcile an offered event, but a generic
duplicate receipt cannot. Already-held attempts require matching wake evidence or
separately authorized operator investigation; no automatic reset command is provided.

Kyberion's wrapper retries/failover and Anthropic request retries are disabled
lexically for these attempts. This does not control the internal behavior of
external CLI runtimes or promise exactly-once downstream business effects.
Downstream operations still need their own idempotency. Existing wake-receipt
replay remains unchanged and is not bounded by the event-reader limits. Atomic
snapshot writes do not establish a tested sudden-power-loss durability guarantee.

Missing/malformed checkpoints, orphan snapshots, changed triggers/scope,
source rotation/truncation, changed anchors, malformed complete rows and oversized
rows stop continuation. Do not delete or reset evidence to resume. Preserve the
charter, source, checkpoint, wake/runner receipts and downstream effect evidence;
a separately approved recovery must reconcile the exact activation/event/attempt
before any replay decision. A trailing incomplete source line waits for completion.
Status reads inspect recorded state/continuity without scanning every unread row
or establishing process liveness.

Regression gates: real distinct-payload acceptance above 2,000 rows, byte cutoff,
bounded pending pressure, new-process restart and competing process claims,
stale offers, pre/post-dispatch failure, partial wake-tool effects, terminal
receipt correlation, tenant/full-scope isolation and fail-closed state/source loss.
Never invoke real providers, notifications or resident daemons for these fixtures.
