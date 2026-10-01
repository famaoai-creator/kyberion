# dots/ — resident agent charters

A **dot** is a resident agent that holds a standing responsibility across
sessions — the same shape as OpenAI's "dots" (always-on agents that keep
working between conversations), expressed in Kyberion terms.

Each `*.json` file here is a **dot charter** validated against
[`knowledge/product/schemas/dot-charter.schema.json`](../knowledge/product/schemas/dot-charter.schema.json)
and loaded via `@agent/core/dot/dot-charter`.

## What a charter declares

| Section        | Meaning                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `purpose`      | The standing responsibility (what this dot owns, continuously)                                     |
| `scope`        | Data tier + optional tenant/org/project — the context chain it operates inside                     |
| `goal`         | Durable goal text + optional per-wake budgets (turns, wall-clock, tokens)                          |
| `attention`    | Triggers: `cron` (scheduled wake), `watch` (file/event), `wake` (inbound channel/surface signals)  |
| `authority`    | An **existing** authority role from `security-policy.json` — a charter never grants authority      |
| `decisions`    | Floor for `autonomous-ops-gate` outcomes (`auto`/`notify`/`approve`) + veto window + escalate chan |
| `notification` | `deliver_to` (slack/telegram/discord/imessage) + optional digest cron + quiet hours                |
| `runtime`      | `heartbeat_id` watched by `daemon-watchdog`, optional reasoning backend                            |

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

- `draft` — declared but not driven (all charters ship as draft until the
  resident runtime multiplexes them).
- `active` — driven by the resident runtime.
- `paused` — suspended; triggers are ignored.
- `retired` — kept for audit; never driven.

## Adding a dot

1. Copy an existing charter, keep `status: "draft"`.
2. Pick an `authority_role` that already exists in `security-policy.json`
   (`authority_role_permissions`) — create it via `pnpm organization role …`
   first if none fits.
3. Validate: the schema is enforced by `validateDotCharter` —
   `pnpm vitest run libs/core/dot/dot-charter.test.ts` covers the loader.
4. Tenant-scoped dots live in `knowledge/confidential/{tenant}/dots/` and run
   under the tenant-bound runner, mirroring the scheduled-pipeline convention.

See [resident-dot-model](../knowledge/product/architecture/resident-dot-model.md)
for the mapping to OpenAI dots and the runtime wiring plan.
