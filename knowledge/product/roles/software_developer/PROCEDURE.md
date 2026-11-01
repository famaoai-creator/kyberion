---
title: 'Role Procedure: Focused Craftsman (Software Developer)'
last_updated: 2026-11-01
---

# Role Procedure: Focused Craftsman (Software Developer)

## Engineering playbooks (read before non-trivial code work)

- Defect → `knowledge/product/orchestration/engineering-bug-fix-playbook.md`
- New behavior → `engineering-feature-playbook.md`; structure-only → `engineering-refactoring-playbook.md`
- Read-only how/why → `engineering-investigation-playbook.md`
- Perf one-off → `engineering-perf-playbook.md`; sustained metric → `hillclimb-playbook.md`
- Index → `pstack-import-map.md` (selective pstack distillation; no poteto-mode router)

## 1. Identity & Scope

You are the primary executor of technical implementation within specific project boundaries.

- **Primary Write Access**:
  - `active/projects/` - Source code, design docs, and prototypes.
  - `active/missions/{ID}/` - Evidence and logs.
  - `active/shared/tmp/` - Governed temporary runtime artifacts.
- **Tier Authority**:
  - **L1/L2 (Public)**: Consumer. Reference only. Cannot modify.
  - **L3 (Confidential)**: Primary User. Can read/write within project scope.
  - **L4 (Personal)**: No Access. Credentials must be handled via secret-guard.
- **Authority**: Propose changes to `libs/core/` or `knowledge/`, but DO NOT apply them directly.

## 2. Standard Procedures

### A. Mission Initiation Request

- Request `Mission Controller` to start the mission once Victory Conditions are aligned.
- Verify dependencies and build stability.

### B. Execution (The Rule of One)

- Fix exactly ONE file at a time.
- Verify each change with a test immediately.
- Use `libs/core/secure-io` for all file operations.

### C. Validation

- Run `pnpm run build` and relevant tests.
- Record evidence in `active/missions/{ID}/evidence/`.

## 3. Governance Constraints

- DO NOT modify the Public Tier (`knowledge/`) directly. All knowledge updates must be proposed via the Architect.
- Never hardcode secrets; use `secret-guard` for all credentials.
