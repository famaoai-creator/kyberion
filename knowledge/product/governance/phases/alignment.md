---
title: 'Phase Protocol: Alignment'
tags: [governance, lifecycle, alignment]
last_updated: 2026-08-01
runtime_stages: [intake, classification, planning]
---

# Phase Protocol: ③ Alignment

## Goal

Interpret the Sovereign's intent, define Victory Conditions, and resolve the execution shape using the canonical work-scope policy. Alignment may select a mission, task-session, pipeline, direct reply, or another catalog rung; it does not itself imply mission creation.

## Directives

1. **Intent Declaration**: Interpret the Sovereign's request into actionable, measurable goals.
2. **Context Ranking**: Run `node dist/scripts/context_ranker.js --intent "..." --role "..." --limit 7` yourself to identify the TOP-7 most relevant knowledge files to minimize noise. This is a **manual step the agent performs**, not something `surface-runtime-orchestrator.ts` invokes automatically — there is no code path that shells out to `context_ranker` on your behalf. Skipping it means Alignment proceeds without the noise-reduction pass.
3. **Strategy Formulation**: Create a clear `TASK_BOARD.md` or execution plan before making any physical changes.
4. **Sovereign Switch**: Determine the mode (Governance-First or Autonomous-YOLO) based on the request's risk and complexity.

## Constraints

- **Zero Physical Change**: Do not modify project source files during the alignment phase.
- **Sudo Gate**: Any decision involving risk (level >= 4) or architectural change requires explicit Sovereign approval.
- **Contract Integrity**: Execution without a plan is recklessness. Every mission must have a defined contract and Victory Conditions before proceeding.
- **Role Resolution**: I MUST resolve my current role in the following priority: Mission Mask > Global Mask > Personal Legacy.

## Physical Enforcement

When the resolved execution shape is `mission`, the agent MUST execute the following command to set the mission to "Active". When the resolved shape is below `mission`, continue through the selected `direct_reply`, `task_session`, or `pipeline` path and do not call `mission_controller start`.

- **Command**: `node dist/scripts/mission_controller.js start <MISSION_ID> --persona <PERSONA> --tier <TIER>`
- **Validation**:
  - Verification of `my-identity.json`.
  - Automatic creation and switching to the mission branch (`mission/id`).
  - Initialization of `mission-state.json`.

Only `MISSION_ID` is positional.
Project and track relationships must be passed as named options such as:

- `--project-id`
- `--project-path`
- `--project-relationship`
- `--track-id`
- `--track-name`
- `--track-type`
- `--lifecycle-model`

---

_Status: Mandated by AGENTS.md for mission-shaped work; the shape decision is governed by `knowledge/product/governance/work-scope-policy.json`._
