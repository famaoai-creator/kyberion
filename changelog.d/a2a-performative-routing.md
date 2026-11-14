---
category: Changed
---

- **A2A bridge refuses performatives it cannot honour** — `a2aBridge.route()` now delivers only envelopes whose `performative` is `request`, `query` or `inform`; all three are delivered as a prompt, as before. `propose`, `accept`, `reject`, `result` and unknown values are refused with `[A2A_PERFORMATIVE_NOT_ROUTABLE]` before any agent is spawned, and the bridge writes the refusal to the audit chain. Send `request` for anything an agent should answer. The agent-actuator `a2a` op does not retry the refusal. A surface agent's `a2a` block and the Concierge `POST /api/ops/agents` action `a2a` (HTTP 400) are rejected before they reach the bridge.
- **Agent execution port: tasks without a WorkItem** — a delegated task without `work_item_id` must name the same mission in `mission_id` and `security_scope.mission_id`; otherwise the receipt fails with `[AGENT_TASK_MISSION_MISMATCH]`. The caller's `agent_profile_id`, `team_role_id` and `authority_role_id` are no longer stored on the runtime record of such a task. Each such delegation is recorded as `agent_delegation_unclaimed` in the audit chain (decision, then outcome) and in the supervisor event stream.
