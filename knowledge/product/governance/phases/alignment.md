---
title: 'Phase Protocol: Alignment'
tags: [governance, lifecycle, alignment]
last_updated: 2026-08-11
runtime_stages: [intake, classification, planning]
---

# Phase Protocol: ③ Alignment

## Goal

Interpret the Sovereign's intent, define Victory Conditions, and resolve the execution shape using the canonical work-scope policy. Alignment may select a mission, task-session, pipeline, direct reply, or another catalog rung. For workflows that declare an `ALIGNMENT_APPROVED` gate, it also produces the hash-bound mission brief and routes human approval through the shared approval store.

`alignment` is a governed sub-phase layered under the `planning` runtime stage; it is not a new classification stage. Keep the `runtime_stages` frontmatter aligned with `mission-classification-policy.json` until the canonical stage progression changes.

## Directives

1. **Intent Declaration**: Interpret the Sovereign's request into actionable, measurable goals.
2. **Context Ranking**: Run `node dist/scripts/context_ranker.js --intent "..." --role "..." --limit 7` yourself to identify the TOP-7 most relevant knowledge files to minimize noise. This is a **manual step the agent performs**, not something `surface-runtime-orchestrator.ts` invokes automatically — there is no code path that shells out to `context_ranker` on your behalf. Skipping it means Alignment proceeds without the noise-reduction pass.
3. **Strategy Formulation**: Create a clear `TASK_BOARD.md` or execution plan before making any physical changes.
4. **Sovereign Switch**: Determine the mode (Governance-First or Autonomous-YOLO) based on the request's risk and complexity.
5. **Alignment-gated workflow**: When the selected workflow declares `ALIGNMENT_APPROVED`, create `evidence/mission-brief.json`, create the shared `approval-store` request, and keep the brief hash-bound to that request. A surface may render and collect the human decision, but the gate reads the approval-store record.

## MO-11 approval flow

For a mission-shaped request with an alignment gate, the governed order is:

1. Resolve the workflow and agree on the intent, scope, Victory Conditions, and execution plan.
2. Run `mission_controller create <MISSION_ID> ...` to create the governed mission micro-repository in `planned` state. This is setup, not approval and not execution. Use `start` only for the existing lifecycle operation that activates a mission outside this approval flow.
3. Run `mission_controller plan-tasks <MISSION_ID> --refresh-catalog`, then create the brief and approval request with `mission_alignment_request.js`.
4. Serve the brief with `mission-alignment-gate/serve-brief.ts`, or render it in another approved surface. The surface writes the decision to the shared approval store; it is not the decision authority.
5. Run `mission_controller gate-pass <MISSION_ID> ALIGNMENT_APPROVED`. The strict command gate checks the approval-store decision and the unchanged brief hash. The first successful gate pass transitions the mission from `planned` to `active`.
6. Continue with the planned execution and verification steps.

The browser must not invoke `mission_controller create` or `start`. Creation is an explicit, auditable session operation; approval remains required before activation.

## Constraints

- **Zero Physical Change**: Do not modify project source files during the alignment phase. Creating a governed mission micro-repository in `planned` state is lifecycle setup, not a project-source change.
- **Sudo Gate**: Any decision involving risk (level >= 4) or architectural change requires explicit Sovereign approval.
- **Contract Integrity**: Execution without a plan is recklessness. Every mission must have a defined contract and Victory Conditions before proceeding.
- **Role Resolution**: I MUST resolve my current role in the following priority: Mission Mask > Global Mask > Personal Legacy.

## Physical Enforcement

When the resolved execution shape is `mission`, the agent MUST create the mission in `planned` state, prepare its tasks and alignment evidence, and pass every declared gate before execution. When the resolved shape is below `mission`, continue through the selected `direct_reply`, `task_session`, or `pipeline` path and do not call `mission_controller start`.

- **Command**: `node dist/scripts/mission_controller.js create <MISSION_ID> --persona <PERSONA> --tier <TIER>`
- **Validation**:
  - Verification of `my-identity.json`.
  - Automatic creation and switching to the mission branch (`mission/id`) with the mission initially `planned`.
  - Initialization of `mission-state.json`.
  - The first successful `ALIGNMENT_APPROVED` gate pass activates the mission; a failed or missing approval cannot activate it.

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
