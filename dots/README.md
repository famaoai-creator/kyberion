# dots/ — resident agent charters

A **dot** is a resident agent that holds a standing responsibility across
sessions — the same shape as OpenAI's "dots" (always-on agents that keep
working between conversations), expressed in Kyberion terms.

Each `*.json` file here is a **dot charter** validated against
[`knowledge/product/schemas/dot-charter.schema.json`](../knowledge/product/schemas/dot-charter.schema.json)
and loaded via `@agent/core/dot/dot-charter`.

## What a charter declares

| Section        | Meaning                                                                                                                                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purpose`      | The standing responsibility (what this dot owns, continuously)                                                                                                                                                                                                                                            |
| `scope`        | Data tier + optional tenant/org/project — the context chain it operates inside                                                                                                                                                                                                                            |
| `goal`         | Durable goal text + optional per-wake budgets (turns, wall-clock, tokens)                                                                                                                                                                                                                                 |
| `attention`    | Triggers: `cron` (scheduled wake), `watch` (file/event), `wake` (inbound channel/surface signals), `probe` (declarative external-state watch: `file` or `service_preset`, evaluated each sweep against `dot-probe-state.json` fingerprints — `changed` expectations fire only after the baseline differs) |
| `authority`    | An **existing** authority role from `security-policy.json` — a charter never grants authority                                                                                                                                                                                                             |
| `decisions`    | Floor for `autonomous-ops-gate` outcomes (`auto`/`notify`/`approve`) + veto window + `decision_expiry_minutes` (default 1440) + escalate chan                                                                                                                                                             |
| `notification` | `deliver_to` (slack/telegram/discord/imessage) + optional digest cron + quiet hours                                                                                                                                                                                                                       |
| `runtime`      | `heartbeat_id` watched by `daemon-watchdog`, optional reasoning backend                                                                                                                                                                                                                                   |
| `team`         | Exclusive `responsibilities` keys (activation refused on overlap), `accepts_handoffs_from` (dots allowed to hand work here), `goal_ref` (organization goal), `owns` (target patterns this dot owns) and `priority` (0-100, arbitration)                                                                   |

`goal.signal_probes` makes `success_signals` measurable (a signal is healthy
while its probe matches). `notification.delivery_mode` is `inbox` by default;
set `live` to send to `deliver_to`.

## Closed-loop fields (organization loop)

A dot can execute, measure and learn, not only propose. All fields below are
optional; the full design is in
[resident-dot-model](../knowledge/product/architecture/resident-dot-model.md)
"The closed organization loop".

| Field                                | Meaning                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `goal.key_results[]`                 | Measurable KRs (`probe` / `file` / `signal_ratio` / `org_metric`) with `target`, `direction`, `every_s`, `settle_minutes` |
| `goal.outcome_settle_minutes`        | Minutes after completion before an action's KR effect is judged (default 60)                                              |
| `authority.allowed_pipelines`        | Repo-relative pipelines the executor may run for `pipeline`-shaped work                                                   |
| `attention.triggers[].kind: "event"` | Wake on an authenticated inbound event (`sources`, `types`, `match`)                                                      |
| `memory` / `followups`               | Working memory (`max_bytes`) and self-scheduled follow-ups (`max_pending`, default 3)                                     |
| `autonomy`                           | `initial_level` / `min_level` / `max_level`, L0-L4 (default L2, ceiling L3)                                               |
| `team.owns` / `team.priority`        | Arbitration inputs when two dots target the same resource                                                                 |
| `runtime.cron_catch_up_hours`        | Missed cron minutes coalesced into one wake (default 6, max 24)                                                           |
| `runtime.max_idle_wake_ms`           | Watchdog staleness bound for this dot's heartbeat (dots heartbeat per wake); it does not force wakes                      |
| `operations_cadence`                 | Organization cadences run by the supervisor for this charter's own organization (see below)                               |

```json
{
  "goal": {
    "statement": "Keep overdue operations under control.",
    "outcome_settle_minutes": 30,
    "key_results": [
      {
        "kr_id": "overdue",
        "title": "Overdue operations",
        "metric": { "source": "org_metric", "metric": "overdue_operations" },
        "target": 2,
        "direction": "decrease",
        "baseline": 8,
        "every_s": 900
      }
    ]
  },
  "attention": {
    "triggers": [
      { "kind": "cron", "cron": "0 9 * * *", "timezone": "Asia/Tokyo" },
      { "kind": "event", "sources": ["ci"], "types": ["build_failed"] }
    ]
  },
  "authority": {
    "authority_role": "infrastructure_sentinel",
    "allowed_work_shapes": ["direct_reply", "pipeline"],
    "allowed_pipelines": ["pipelines/ok.json"]
  },
  "memory": { "enabled": true, "max_bytes": 8192 },
  "followups": { "max_pending": 3 },
  "autonomy": { "initial_level": "L2", "max_level": "L3" },
  "team": { "owns": ["service:ops"], "priority": 60 }
}
```

In a wake the dot reports `expected_effect` (`{kr_id, direction}`) and `target`
on proposals, and may emit `dot-memory` / `dot-followup` fences (or the
matching tools). State is kept under `active/shared/runtime/dot/`.

### Operator steps

1. **Event intake (off by default)**: enable the source on this host with
   `KYBERION_EVENT_INTAKE_SOURCES=<id>[,<id>]` (or `enabled: true` in
   `knowledge/product/governance/event-intake-policy.json` for every host; bind a
   `tenant_slug` for tenant sources) and register its HMAC secret under the
   source's `secret_key` (for example `EVENT_INTAKE_CI_SECRET`) by introducing
   it under the `event-intake` service without the prefix:
   `pnpm kyberion secret introduce event-intake CI_SECRET --from-file <file>`. The intake
   surface listens on `127.0.0.1` (`KYBERION_EVENT_INTAKE_PORT` /
   `KYBERION_EVENT_INTAKE_HOST`) at `POST /events/<source>`.
   To receive webhooks from the internet (e.g. GitHub), expose only `/events`
   through public ingress: `pnpm kyberion ingress up --surface event-intake`
   (approval-gated; Tailscale Funnel by default) — see
   [expose-surface-public-ingress](../knowledge/public/procedures/expose-surface-public-ingress.md).
2. **Cadence pipelines (opt-in)**: `organization-operation-tick`,
   `organization-standup` and `organization-retro` ship `enabled: false`.
   Enable per host with
   `KYBERION_CHRONOS_SCHEDULES=organization-operation-tick,organization-standup,organization-retro`.
3. **Restart the supervisor daemon after `pnpm build`.** The daemon is
   long-lived; it keeps running the previous compiled loop (executor, KR
   measurement, outcomes, autonomy) until restarted.
4. Check `pnpm kyberion dot status` for the executor, KR, outcome, budget and
   autonomy sections. A promotion above L2 is only applied after a human
   approves its decision card.
5. **Release a quarantined WorkItem** (see "Executor limitations" below):
   inspect `pnpm kyberion dot work <dot_id>` and the WorkItem, verify on the
   target system whether the earlier attempt had any effect (undo or finish it
   by hand if needed), then run
   `pnpm kyberion dot release <dot_id> <work_item_id> --reason "<what you verified>" [--by user:<member_id>]`.
   This only creates a human-only approval request (it prints its id); a
   human approves it with `pnpm kyberion approvals --approve <id>` (72 h
   before it expires). The next executor sweep then records
   `metadata.dot_executor.operator_verified_at/by/reason` from the approver,
   audits `dot_work_item_operator_release` and returns the item to `ready`;
   the sweep after re-attempts it under a new attempt id. A rejected, expired
   or non-human decision, a tenant mismatch, or an item changed since the
   request releases nothing — request again if still needed. To close
   it instead, leave it archived (or cancel it through the work board). Do not
   reopen the item directly — a plain reopen is re-archived as a conflict.

### Executor limitations

- `task_session` is **not available**: no governed task-session executor
  ships yet. It is not a default shape, and dispatch refuses a `task_session`
  proposal before the gate or any operator ask, even when a charter declares
  it. Use `pipeline` (with a `pipeline_ref` from `allowed_pipelines`) for
  effects and `direct_reply` for advisory answers. A legacy `task_session`
  item is closed as blocked (`reason_code: capability_unavailable`) without
  waking the dot; the dot sees it in its work results on the next wake.
- `direct_reply` asks the provider for advisory behavior; not every provider
  enforces it mechanically, so its summary is prefixed as unverified.
- A failure **before any effect** (no backend resolved, pipeline missing or
  invalid, goal driver failing before its first model call) returns the item
  to `ready` for up to 3 attempts, then ends as an escalated failure — never a
  quarantine. Any other error, timeout or stranded claim is quarantined until
  an operator releases it (step 5).

## Organization cadences (`operations_cadence`)

A charter scoped to an organization (`scope.organization_id` set,
`authority.authority_role: organization_operator`) can opt in to that
organization's cadences. The supervisor's `dot-org-cadence` step runs them
inside the charter's execution context (role, tenant, organization) using the
scoped cadence mode — the tenant bound to the run must equal the
organization's tenant, and the audit records `tick:scoped` /
`standup:scoped` / `retro:scoped`.

```json
"operations_cadence": {
  "tick_every_minutes": 15,
  "standup": { "cron": "45 8 * * 1-5", "timezone": "Asia/Tokyo" },
  "retro": { "cron": "0 17 * * 5", "timezone": "Asia/Tokyo" }
}
```

- `tick_every_minutes` (default 15, min 5): governed operation tick for the
  organization's due scheduled operations.
- `standup` / `retro`: run once per cron occurrence. Only the latest
  occurrence inside an 8-day look-back is run, so downtime (or first enabling
  the field) yields at most one catch-up run per cadence, never a storm.
- Markers live in `active/shared/runtime/dot/.../org-cadence.json`; at the
  organization budget hard limit the step skips every cadence; a failure is
  logged and never stops the sweep.

The repo cadence pipelines (`pipelines/organization-{operation-tick,standup,retro}.json`)
stay **sovereign-only** and aggregate across tenants for a single operator;
prefer the dot cadence for per-tenant operation. A dot that wakes only on
weekday crons should set `runtime.max_idle_wake_ms` above the weekend gap
(`dots/org-operations.json` uses 4 days) so the watchdog does not page it.

## Execution model

````
charter ── attention trigger ──▶ bounded goal turn (worker-goal-driver / delegated CLI)
                                   │  ├─ read: everything its role may read
                                   │  └─ propose: dot_propose_action / ```dot-proposals```
                                   ▼
             dot-dispatch (supervisor process, charter role)
               bounds → gate ⊔ charter floor ⊔ learned floor → route
                 ├─ proceed → WorkItem (dot:<id>) or handoff to another dot
                 ├─ parked  → decision card / veto on the charter route → settled next sweeps
                 └─ refused → recorded with the reason
````

The dot is a coordinator, not a worker. Like OpenAI dots delegating to Codex,
it never acts itself: every effect is a governed proposal (see
[resident-dot-model](../knowledge/product/architecture/resident-dot-model.md)
"Governed proposals"). Each sweep also settles parked decisions, measures
signals, and sends the `digest_cron` digest. `pnpm kyberion dot status` shows
actions, open decisions, signals, and recent feedback.

## Status values

- `draft` — declared but not driven.
- `active` — driven by the resident runtime (the agent-runtime-supervisor
  sweep evaluates triggers and runs bounded goal turns).
- `paused` — suspended; triggers are ignored.
- `retired` — kept for audit; never driven.

Status is never hand-edited: use `pnpm kyberion dot activate|pause|retire`.
Activation is gated — the authority role must exist in the canonical role
registry and the `heartbeat_id` must be unique among supervised daemons and
active dots.

Charter writes are performed under the dedicated `dot_lifecycle_writer`
role — never under the role a dot binds at runtime — so an active dot cannot
rewrite the contract it runs under. Every wake re-validates that the bound
role still exists before any work runs.

## Wake semantics

Each wake attempt lands in `active/shared/runtime/dot-wake-ledger.jsonl`
keyed by a stable trigger key (`cron:<expr>@<minute>`, `watch:<path>@<stat>`,
`wake:<inbox-row>`, `probe:<spec>:<fingerprint>`, `manual:<iso>`). Outcomes:
`delivered` consumes the key;
`rejected` consumes it (policy wedges must not hot-loop); `failed` retries
after a 5-minute backoff; `skipped` (paused mid-flight or token cap) leaves
the key due so the event survives the block. `dot status` summarizes wakes
and today's token spend; `dot wake <id>` runs one manual wake under the
charter's role. `pnpm kyberion dot inbox append --channel <ch> [--dot-id <id>]`
appends a wake-lane row by hand — the same row shape channel bridges emit
through `runChannelTurn` (`libs/core/dot/dot-inbox.ts`), so an operator can
fire a wake without a real message.

A `probe` trigger example — wake when a GitHub PR leaves `open`:

```json
{
  "kind": "probe",
  "every_s": 300,
  "probe": {
    "type": "service_preset",
    "service_id": "github",
    "action": "get_pull",
    "params": { "owner": "me", "repo": "kyberion", "pull_number": 123 },
    "expect": { "json_path": "state", "not_equals": "open" }
  }
}
```

## Adding a dot

1. Copy an existing charter, keep `status: "draft"`.
2. Pick an `authority_role` that already exists in the canonical role
   registry (`knowledge/product/governance/authority-roles/`) — create the
   role card plus its `security-policy.json` / `role-write-access.json`
   grants first (run `sync_authority_roles` to regenerate the index) if none
   fits.
3. Validate: `pnpm kyberion dot validate <dot_id>` checks the schema and the
   activation gate; `pnpm kyberion dot activate <dot_id>` flips to active.
4. Tenant-scoped dots live in `knowledge/confidential/{tenant}/dots/` and run
   under the tenant-bound runner, mirroring the scheduled-pipeline convention.

See [resident-dot-model](../knowledge/product/architecture/resident-dot-model.md)
for the mapping to OpenAI dots and the runtime wiring.
