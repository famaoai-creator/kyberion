---
title: Mission Lifecycle and Record Keeping
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution, review]
tags: [mission, lifecycle, kanban, a2a, transport, evidence, record-keeping]
owner: ecosystem_architect
---

# Mission Lifecycle and Record Keeping

This document defines the canonical flow for a team-composing mission in Kyberion.

The goal is to keep the lifecycle stable even when multiple agents, boards,
and transport layers participate.

## Core rule

Separate these concerns explicitly:

- `mission_controller` owns mission-wide lifecycle state
- `Work Coordination Platform` owns durable work state
- `a2a_fanout` owns divergent reasoning and dispatch semantics
- `agmsg`-style or peer transport owns short-lived agent-to-agent messages
- `agent_runtime_supervisor` owns live runtime liveness

`assigned_persona` in mission state is descriptive metadata. It is not the
same thing as the process execution authority that writes mission files.

## Stable flow

```text
Create mission
  -> Start mission
    -> Compose team
      -> Staff / prewarm runtime
        -> Record task intent
          -> Assemble scoped mission context pack
          -> Dispatch durable tickets (WorkItem / GitHub / Jira payloads)
          -> Execute registered work items and reflect results back to tickets
          -> Create / update board items
            -> Delegate work via A2A or short transport
              -> Record evidence and checkpoints
                -> Verify / distill
                  -> Finish mission
```

## Canonical stages and artifacts

| Stage | Owner | Primary artifacts | Notes |
|---|---|---|---|
| Create | `mission_controller` | `mission-state.json`, `team-composition.json`, `team-blueprint.json` | Initializes the mission repo and durable metadata. |
| Start | `mission_controller` | `mission-state.json`, `TASK_BOARD.md`, `ROLE_PROCEDURE.md` | Activates the mission and binds the focus branch. |
| Team | `mission_controller` + team composer | `team-composition.json`, `team-blueprint.json` | Chooses roles and governance before delegation begins. |
| Staff | `agent-runtime-supervisor` | runtime request/result logs, runtime observability | Ensures live agents exist before tasks are delegated. |
| Record task | mission owner / planner | `LATEST_TASK.json`, `execution-ledger.jsonl` | Flight recorder entry for the next unit of work. |
| Context pack | mission owner / planner | `coordination/context-packs/**` | Compiles a scoped mission context pack from mission / project / task / role state before execution. |
| Ticket dispatch | mission owner / planner | `coordination/tickets/**`, `coordination/events/ticket-events.jsonl`, `NEXT_TASKS.json` ticket annotations | Registers mission tasks as durable WorkItem records and optional GitHub / Jira payload artifacts before live routing. |
| Work item dispatch | mission owner / planner | `coordination/tickets/replies/**`, ticket manifest updates, mission evidence response artifacts | Routes registered WorkItems to a live agent or subagent and writes the completion / review result back to the ticket records. |
| Board update | Work Coordination Platform | `WorkItem`, board view, claim/handoff/release state | Durable work tracking; not runtime ownership. |
| A2A / transport | agents | A2A messages, peer transport, short-lived coordination logs | Used for short instructions or branching work, not lifecycle authority. |
| Fanout / critique | `wisdom` ops | `hypothesis-tree*.json`, `dissent-log.json` | Divergent reasoning and review. |
| Checkpoint | `mission_controller` | `mission-state.json`, git checkpoint history | Records a task boundary and mission commit hash. |
| Verify / distill | `mission_controller` | verification output, distilled notes | Moves the mission toward completion. |
| Finish | `mission_controller` | archived mission repo, trace summary | Closes the mission after evidence and validation are complete. |

## Board vs transport

Use the board when you need durable state:

- what work exists
- who owns it
- what is blocked
- what is handed off
- what is awaiting review

Use transport when you need a short-lived message:

- a planning request
- a handoff note
- a critique request
- a status acknowledgement

Transport should not become the source of truth for work state. The board
should project the state that matters for operators.

## A2A usage

`a2a_fanout` is for situations where one viewpoint is not enough.

Use it for:

- alternative design hypotheses
- red-team critique
- implementation tradeoff comparison
- review of hidden failure modes

Do not use it as the only record of mission progress. Its output should be
captured as evidence and projected into the mission board or a summary doc.

## Observed dispatch gap

In the team-composing dispatch flow, `create` and `start` do not touch the
runtime supervisor. The first runtime interaction happens at `staff / prewarm`,
and actual task routing happens later through `dispatchMissionNextTasks(...)`
and `a2a_bridge`.

Observed behavior:

- the target agent can answer once and still disappear from the live runtime
  registry later
- `status = null` / empty runtime lists therefore do not prove that dispatch
  never happened
- they do mean the live runtime is no longer available for later inspection

Operational rule:

- if a dispatched agent response matters, capture it into mission evidence
  immediately
- do not rely on the runtime supervisor snapshot as the only source of truth
  for the response body

## Persona and authority split

- `KYBERION_PERSONA` describes the display / reasoning persona.
- `MISSION_ROLE` and the authority model decide what the process can write.
- `assigned_persona` in mission state is mission metadata, not write authority.

Mission lifecycle commands default to the safe worker persona unless an
explicit override is needed.

This avoids the common failure mode where a system-maintenance persona is used
as if it were the mission write authority.

## Practical operator sequence

For a new team-composing mission, the stable operator sequence is:

1. `mission_controller create <MISSION_ID>`
2. `mission_controller start <MISSION_ID>`
3. `mission_controller team <MISSION_ID>`
4. `mission_controller staff <MISSION_ID>`
5. `mission_controller record-task <MISSION_ID> <DESCRIPTION>`
6. `mission_controller dispatch-tickets <MISSION_ID>`
7. `mission_controller dispatch-workitems <MISSION_ID>`
8. Update the board or work item view
9. Use `a2a_fanout` for divergent analysis or critique
10. `mission_controller checkpoint <MISSION_ID> <TASK_ID> <NOTE>`
11. `mission_controller verify <MISSION_ID> verified <NOTE>`
12. `mission_controller distill <MISSION_ID>`
13. `mission_controller finish <MISSION_ID>`

Each step should leave a durable artifact or audit trail.

## Related docs

- [`mission-orchestration-control-plane.md`](./mission-orchestration-control-plane.md)
- [`work-coordination-platform.md`](../orchestration/work-coordination-platform.md)
- [`agent-runtime-work-coordination-map.md`](./agent-runtime-work-coordination-map.md)
- [`mission-team-composition-model.md`](./mission-team-composition-model.md)
