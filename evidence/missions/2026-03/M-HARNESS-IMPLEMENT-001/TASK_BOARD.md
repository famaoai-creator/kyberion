# TASK_BOARD: Harness Engineering Implementation (M-HARNESS-IMPLEMENT-001)

## Vision Context
- Tenant: default
- Vision: /vision/_default.md (Logic first, Vision for tie-breaking)

## Status: Completed (Execution Phase)

- [x] **Step 1: Project-Level Governance (`WORKFLOW.md`)**
  - [x] Implemented detection of `active/projects/{project}/WORKFLOW.md`.
  - [x] Updated `scripts/context_ranker.ts` to prioritize project-specific workflows (Score: 95) just below Vision.
- [x] **Step 2: Mission-Issue Integration (Handoffs)**
  - [x] Created `scripts/ingest_issue.ts` to create missions directly from external URLs.
  - [x] Added `external_ref` property to `mission-state.schema.json` and mission states.
- [x] **Step 3: Hermetic Workspace Isolation**
  - [x] Finalized protocol: Mission-specific experiments MUST stay in `scratch/` or mission directory to ensure zero side effects.
- [x] **Step 4: Refine Mission Controller**
  - [x] Added `handoff` command to `mission_controller.ts` to transition personas and track history.

## Victory Conditions
- [x] Mission-specific rules can be defined per project using `WORKFLOW.md`.
- [x] Missions can be linked to external issues/triggers.
- [x] Execution environments are more isolated and machine-readable.
