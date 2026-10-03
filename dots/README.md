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
| `decisions`    | Floor for `autonomous-ops-gate` outcomes (`auto`/`notify`/`approve`) + veto window + escalate chan                                                                                                                                                                                                        |
| `notification` | `deliver_to` (slack/telegram/discord/imessage) + optional digest cron + quiet hours                                                                                                                                                                                                                       |
| `runtime`      | `heartbeat_id` watched by `daemon-watchdog`, optional reasoning backend                                                                                                                                                                                                                                   |

## Execution model (target)

```
charter ── attention trigger ──▶ bounded goal turn (worker-goal-driver)
                                   │  ├─ read: everything its role may read
                                   │  ├─ decide: autonomous-ops-gate → auto | notify | approve
                                   │  └─ work: delegate as WorkItem / mission — never direct writes
                                   ▼
                        notification.deliver_to + approvals
```

The dot is a coordinator, not a worker — like OpenAI dots delegating to Codex,
it dispatches substantive work through mission_controller / WorkItems and keeps
the responsibility itself.

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
