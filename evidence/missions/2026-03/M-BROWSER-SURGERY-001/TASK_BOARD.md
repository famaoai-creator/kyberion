# TASK_BOARD: Browser Skill Surgical Refit (M-BROWSER-SURGERY-001)

## Vision Context
- Tenant: default
- Vision: /vision/_default.md (Logic first, Vision for tie-breaking)

## Status: Completed (Surgical Phase)

- [x] **Step 1: Environment & Dependency Fix**
  - [x] Rebuilt `node-pty` to resolve environment errors.
  - [x] Fixed TypeScript build error in `src/lib.ts`.
- [x] **Step 2: Core Engine Refit (iFrame & Login)**
  - [x] Implemented `findTargetAcrossFrames` to penetrate iFrame isolation.
  - [x] Implemented `handleLogin` with agentic discovery and secure `connection_id` resolution.
- [x] **Step 3: High-Level Orchestration (Loop Action)**
  - [x] Implemented `handleLoopAction` for "list-detail-action" automation.
- [x] **Step 4: Validation & Migration Recovery**
  - [x] Verified iFrame click success with a custom reproduction case.
  - [x] Verified automated login with a mock login form.
  - [x] Verified list-looping with a mock list-detail app.

## Victory Conditions
- [x] Engine now supports iFrame-aware discovery automatically.
- [x] Credentials are resolved internally from `knowledge/personal/connections/`.
- [x] Generalized `loop_action` restores full workflow automation capability.
