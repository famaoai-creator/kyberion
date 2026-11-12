# Agent Communications

Kyberion has two distinct message planes:

- **Plane 1: local runtime routing**
  - `libs/core/mesh/a2a-bridge.ts`
  - `libs/core/agent/agent-runtime-supervisor.ts`
  - `scripts/agent_runtime_supervisor_daemon.ts`
  - `libs/core/mesh/peer-messaging.ts` for peer-level envelopes
- **Plane 2: cross-peer messaging**
  - `libs/core/mesh/peer-messaging.ts` (signed envelopes between enrolled peers)
  - `libs/core/mesh/mesh-hub-peer-messaging-adapter.ts` (recipient proposals for allowlisted collaboration requests)

The Mesh message broker and its delivery driver were retired on 2026-11-12 (nothing enqueued deliveries); see
[`retired/README.md`](../../retired/README.md).

The important rule is simple:

- `a2aBridge.route` is the synchronous host-local dispatch path.
- Peer messaging is the cross-peer path; Mesh Hub adds discovery and recipient proposals on top of it.
- The file-backed network transport in `libs/actuators/network-actuator/src/` is a separate envelope-drop transport, not the same thing as `a2aBridge`.

## Correlation flow

The canonical trace keys are:

- `mission_id` for the durable mission scope
- `conversation_id` for the long-running interaction
- `correlation_id` for a single traceable turn or delivery chain

Current propagation order:

1. Incoming A2A envelope carries `conversation_id` and may carry `correlation_id`.
2. `a2aBridge.route` resolves a `correlation_id` if one was not supplied.
3. The resolved `correlation_id` is passed to the supervisor ask path.
4. `agent_runtime_ask_requested` and `agent_runtime_ask_completed` events include the same `correlation_id`.
5. Mesh A2A proposals and workitem commands keep the originating `correlation_id` when they are derived from mesh requests.

## Log locations

The system writes the same trace across several append-only stores:

- `active/shared/observability/mission-control/orchestration-events.jsonl`
- `active/shared/observability/mission-control/agent-runtime-supervisor-events.jsonl`
- `active/shared/observability/mesh-hub/**/events.jsonl`
- `active/shared/runtime/peer-messaging/**`

For a single operator view, join those records on `mission_id`, `conversation_id`, and `correlation_id`.

## Practical note

When adding a new message path:

- preserve the existing envelope fields
- add `correlation_id` as an optional field first
- keep logs append-only
- avoid dropping parse failures silently
