# Role / Persona Matrix

This document is the operational reference for answering a simple question:

> "If this role exists, what does it imply, and what does it not imply?"

Use it as a mental model, not as a source of new permissions. Actual access is enforced by `knowledge/public/governance/security-policy.json` and `knowledge/public/governance/authority-role-index.json`.

## Bottom line

Yes: the design direction is to keep **service names out of `persona`, `role`, and `authority` names**.

- `persona` stays broad: trust envelope, not vendor or channel.
- `authority` stays generic: permission token, not service label.
- `role` should describe responsibility, not transport vendor.
- Service-specific names belong in **surface instances** and **transport config**, not in new policy roles.
- Existing service-named legacy roles can remain until a migration plan replaces them.

## Core terms

| Term | Meaning |
|---|---|
| Persona | Broad trust envelope and operating mode. It is the coarse identity used by policy and tier checks. |
| Authority role | Concrete job function for execution-time write scopes and surface boundaries. |
| Permission | The actual path or authority grant enforced by tier-guard and secure-io. |

## Rule of thumb

Roles do not automatically imply each other.

- `surface_runtime` does not imply `slack_bridge`.
- `slack_bridge` does not imply `surface_runtime`.
- `chronos_gateway` does not imply `chronos_operator`.
- `mission_controller` does not imply `software_developer`.
- `knowledge_steward` does not imply `sovereign`.

Treat combined workflows as explicit composites. If a workflow touches both a runtime surface and Slack transport, it needs both boundaries satisfied. If it touches only one, do not invent the other.

## Naming rule

Prefer responsibility names over service names.

- Good: `channel_bridge`, `control_surface_gateway`, `runtime_surface`
- Current responsibility roles: `slack_bridge`, `chronos_gateway`, `surface_runtime`
- Current surface instances: `slack-bridge`, `imessage-bridge`, `telegram-bridge`, `terminal-bridge`

Do not collapse these layers into one another.

- A **role** is a policy and execution boundary.
- A **surface instance** is a running integration or daemon with a concrete `id`.
- A **transport** is the backend or channel family the surface uses.

Service-specific behavior belongs in transport config, registry data, or surface metadata, not in the responsibility role name. The role should tell you what boundary it owns, not which vendor it happens to route through.

`slack_bridge` remains a legacy operational role in the current codebase. It is acceptable for now, but it should not become the template for new responsibility-role names. Existing service-specific surface instances such as `imessage-bridge` are cataloged as runtime surfaces, not as a reason to mint new policy roles.

## Short explanation you can reuse

If you need to explain this to someone else, use this phrasing:

> Persona, authority, and role should stay generic. Service names belong in the running surface or transport layer. We keep legacy service-named roles for now, but we do not use them as the pattern for new ones.

## Persona matrix

| Persona | What it is for | Common roles that resolve to it |
|---|---|---|
| `sovereign` | Highest local operator envelope. Used for onboarding, customer overlay creation, and direct repo or knowledge changes that need broad write scope. | `sovereign_concierge` |
| `ecosystem_architect` | Repo architecture and core evolution envelope. Used when the change is about the platform itself. | `ecosystem_architect` |
| `worker` | Execution envelope for mission and surface roles. Most operational roles land here. | `mission_controller`, `software_developer`, `slack_bridge`, `chronos_gateway`, `chronos_operator`, `chronos_localadmin`, `surface_runtime`, `infrastructure_sentinel`, `service_actuator` |
| `analyst` | Read-heavy inspection, governance review, and knowledge maintenance. | `knowledge_steward`, `ruthless_auditor`, `cyber_security` |
| `mission_owner` | Mission-state label / contextual assignment. It is not a write grant by itself. | Derived from mission metadata, not from an execution role |
| `unknown` | Fallback when the role or persona cannot be resolved. Treat as insufficient until proven otherwise. | Anything not recognized by the mapping |

## Role matrix

| Role | Default persona | What it does | What it does not imply |
|---|---|---|---|
| `sovereign_concierge` | `sovereign` | Customer creation, onboarding, identity sync, and customer overlay setup. | It does not imply Slack ingress, Chronos control, or mission execution authority. |
| `mission_controller` | `worker` | Mission lifecycle, checkpoints, coordination, and observability. | It does not imply code-authoring authority. |
| `software_developer` | `worker` | Implementation work on tests, product code, and actuator surfaces. | It does not imply mission control or customer onboarding by itself. |
| `knowledge_steward` | `analyst` | Governed knowledge maintenance, including customer overlay knowledge trees. | It does not imply broad sovereign repo write access. |
| `slack_bridge` | `worker` | Slack ingress / egress and channel observability. | It does not imply managed runtime supervision. |
| `chronos_gateway` | `worker` | Chronos control surface and terminal routing. | It does not imply read-only operator mode or Slack transport. |
| `chronos_operator` | `worker` | Read-only Chronos visibility and runtime observability. | It does not imply write access to Chronos coordination scopes. |
| `chronos_localadmin` | `worker` | Local Chronos administration for deterministic coordination and runtime control. | It does not imply Slack-specific transport authority. |
| `surface_runtime` | `worker` | Reconciliation and supervision of managed runtime surfaces. | It does not imply Slack transport or channel ingress. |
| `infrastructure_sentinel` | `worker` | Coordination and observability for infrastructure-backed surfaces. | It does not imply mission lifecycle control. |
| `service_actuator` | not auto-inferred | Service integration helper for connection documents and auth-grant aware reads. | It does not imply a persona default or broad write permissions. |
| `ruthless_auditor` | `analyst` | Audit and forensic review. | It does not imply operator write access. |
| `cyber_security` | `analyst` | Security analysis and security knowledge maintenance. | It does not imply customer onboarding authority. |
| `nexus_daemon` | not auto-inferred | Bridge daemon / runtime coordination helper for the nexus surface. | It does not imply a persona default or general authoring rights. |
| `run_pipeline` | not auto-inferred | Pipeline execution authority used by governed scripts. | It does not imply human-facing runtime or Slack control. |
| `run_super_pipeline` | not auto-inferred | Higher-order pipeline execution authority for super-pipelines. | It does not imply ordinary developer authoring rights. |

## Current surface-instance catalog

These are runtime surface ids already present in the repo. They are not automatically policy roles.

| Surface instance | Family | Notes |
|---|---|---|
| `slack-bridge` | messaging bridge | Slack ingress / egress and governed observability. |
| `imessage-bridge` | messaging bridge | Managed macOS Messages bridge for declared iMessage sending. |
| `telegram-bridge` | messaging bridge | Telegram ingress / egress and governed observability. |
| `terminal-bridge` | runtime bridge | Background terminal bridge for runtime sessions. |
| `nexus-daemon` | coordination bridge | Runtime daemon for the nexus surface. |

## How to explain the common confusion

If someone asks, "Does `surface_runtime` mean we also need `slack_bridge`?"

- Answer: **No, not by default.**
- `surface_runtime` is about supervising managed surfaces and runtime state.
- `slack_bridge` is about Slack ingress, egress, and observability.
- Only add both when the workflow crosses both boundaries.

If someone asks, "What is `imessage-bridge` then?"

- Answer: it is a **surface instance**, not a new permission concept.
- It lives in the messaging bridge family, alongside `slack-bridge`.
- Its existence does not mean policy should grow a separate `imessage_bridge` role unless the boundary itself is materially different.

If someone asks, "Does `knowledge_steward` mean the same thing as `sovereign`?"

- Answer: **No.**
- `knowledge_steward` is a maintenance role over governed knowledge trees.
- `sovereign` is the broad local operator envelope used for onboarding and customer overlay setup.

## Practical decision rule

When designing a new workflow:

1. Name the surface first: mission, knowledge, Slack, Chronos, runtime, or customer overlay.
2. Pick the smallest role that owns that surface.
3. Add a second role only if the workflow really crosses a second surface boundary.
4. If you need both read and write, verify the write scope explicitly instead of assuming the role implies it.
