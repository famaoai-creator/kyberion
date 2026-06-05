---
title: Mission Context Injection Model
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution, review]
tags: [mission, context, injection, pack, tier, tenant, knowledge]
owner: ecosystem_architect
---

# Mission Context Injection Model

Kyberion missions should not inject the full repository knowledge base into
every agent. Instead, each execution surface compiles a scoped **mission
context pack** that contains only the minimum information needed for a role
to act.

This is the concrete delivery artifact for the tiered reading order described
in [`context-precedence-protocol.md`](../orchestration/context-precedence-protocol.md):

1. `AGENTS.md`
2. mission / project governance
3. surface-specific operator aids
4. ad hoc prompt text

The mission context pack sits between governance and the final prompt. It is a
compiled, role-specific representation of:

- mission state
- project operational state
- track state
- task session state
- work item state
- scoped distilled knowledge hints
- source references and redactions

## Core principle

The pack should answer:

- What mission is this?
- Which role is being addressed?
- What project / track / task / work item context is relevant?
- Which distilled knowledge snippets are actually useful?
- What was intentionally omitted?

It should not answer:

- the full history of Kyberion
- unrelated missions
- cross-tier or cross-tenant data that is not authorized
- every available team role or runtime detail

## Pack shape

The canonical pack shape is defined in:

- [`mission-context-pack.schema.json`](../schemas/mission-context-pack.schema.json)
- [`libs/core/mission-context-pack.ts`](/Users/famao/kyberion/libs/core/mission-context-pack.ts)

The pack includes:

- `scope`
  - tier
  - tenant slug
  - mission id
  - project id
  - track id
  - task session id
  - work item id
- `recipient`
  - `agent` / `subagent` / `reviewer` / `operator` / `planner` / `tester`
  - resolved team role
  - resolved assignment / authority role when available
- `mission`
  - mission status, persona, mission type, relationship summary
- `project`
  - live project operational state summary when the project is in scope
- `track`
  - project track summary when the track is in scope
- `task_session`
  - session summary and goal
- `work_item`
  - the concrete task being executed
- `knowledge_hints`
  - a small set of distilled, relevant knowledge entries
- `artifact_hints`
  - reusable canonical artifact references from the project-level artifact registry
- `sources`
  - traceability references used to build the pack
- `redactions`
  - what was intentionally excluded

## Assembly flow

```text
Mission state
  -> project / track / task session / work item / artifact registry resolution
    -> role-specific assignment resolution
      -> relevant distilled knowledge hints + reusable artifact hints
        -> mission context pack
          -> prompt / artifact delivery
            -> agent execution
              -> evidence + ticket reflection
                -> project / mission state update
                  -> distill back into knowledge
```

## Storage path

Mission context packs are mission-local artifacts and should be written under:

```text
active/missions/<tier>/<mission_id>/coordination/context-packs/
```

This keeps the pack:

- auditable
- reproducible
- mission-scoped
- separate from the global knowledge corpus

## Delivery rule

The pack must be tailored to the recipient:

- planners get decomposition and sequencing context
- implementers get the task, target artifact, and relevant constraints
- reviewers get acceptance criteria and evidence references
- operators get runtime / binding / operational state
- testers get verification targets and expected outcomes

Do not use one universal prompt for every role.

## Distillation rule

The pack is ephemeral execution context.

After execution:

- response bodies
- artifact paths
- review results
- blockers
- learnings

must be reflected back into mission-local state and project operational state
first, then distilled into `knowledge/` later.

Knowledge is the derived store, not the source of truth for execution.

## Implementation boundaries

The scoped injection flow should be owned by these modules or boundaries:

- `libs/core/mission-context-pack.ts`
  - resolve mission / project / track / task session / work item state
  - filter source facts by tier, tenant, role, and scope
  - inject reusable artifact hints from the project-level artifact registry
  - assemble the mission context pack
  - render the pack into prompt text
  - persist the pack into mission-local coordination storage
- `libs/core/distill-knowledge-injector.ts`
  - resolve distilled knowledge hints that are relevant to the scoped pack
  - keep the knowledge source as a derived input, not the primary execution store
- `scripts/refactor/mission-workitem-dispatch.ts`
  - request a scoped context pack before dispatch
  - deliver the pack to the selected agent or subagent
  - record what was sent, to whom, when, and why
  - write response artifacts, ticket reflections, and work-item metadata
- `scripts/refactor/mission-ticket-dispatch.ts`
  - register ticket payloads and source metadata for planned work
  - preserve the source of truth for assignment intent before execution
- `scripts/refactor/mission-distill.ts`
  - convert execution evidence and reflections into distillable knowledge
  - update knowledge only after execution evidence exists
- `scripts/refactor/project-state-sync.ts`
  - reflect mission outcomes back into the project operational state
- `scripts/mission_controller.ts`
  - orchestrate mission lifecycle transitions without embedding full knowledge into every agent prompt

## Acceptance criteria

The design is considered complete when the following are true:

1. Agents receive a scoped context pack that is tailored to their role and mission scope.
2. No dispatch path injects the full Kyberion knowledge base by default.
3. Every dispatched task records the pack id, pack path, recipient, and source references.
4. Reusable artifact hints can be resolved from the project-level registry without forcing the artifact itself into mission-local ownership.
5. Mission-local evidence, ticket reflections, and project state are updated after execution.
6. Knowledge is only updated through distillation after execution evidence exists.
7. Tier and tenant isolation are preserved in both the pack and the persisted artifacts.
8. The same mission can be replayed or audited from the stored pack, artifact hints, and execution artifacts.

## Related docs

- [`mission-lifecycle-and-record-keeping.md`](./mission-lifecycle-and-record-keeping.md)
- [`project-operational-state-store.md`](./project-operational-state-store.md)
- [`work-coordination-platform.md`](../orchestration/work-coordination-platform.md)
- [`context-precedence-protocol.md`](../orchestration/context-precedence-protocol.md)
