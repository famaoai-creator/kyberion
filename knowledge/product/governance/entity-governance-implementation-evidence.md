# Entity Governance Implementation Evidence

Mission: `MSN-EG-20260809B`
Date: 2026-08-09

## Requirements and design

- `knowledge/product/architecture/entity-scope-hierarchy.md` and
  `libs/core/entity-scope.ts` define one executable scope order.
- Tenant, organization, project, mission, work-item, and artifact ownership
  paths are checked at their governed facades and at the secure-io boundary.
- Cross-tenant mission/project access is denied and audited; work-item context
  is typed and legacy context migration reports zero remaining records.
- Retention, audit freshness, plan-ledger, tracked-ignore, workspace, and
  mission-hygiene checks are wired into `check:entity-governance` and CI.

## Runtime adjudication

- The EG cleanup dry-run detected 8 mission trees, 84 unregistered or
  noncanonical project workspaces, and 7 legacy distill artifacts.
- Approved governed apply moved all soft-delete targets to
  `active/archive/.trash/eg-mslepxo3/` and moved legacy distills to
  `knowledge/product/evolution/`.
- The apply receipt is recorded at
  `active/missions/confidential/MSN-EG-20260809B/evidence/entity-governance-cleanup-receipt.json`.
- A post-apply dry-run returned zero findings; the detector returned
  `status: ok` with zero violations and warnings.

## Verification

- `pnpm --filter @agent/core run build`: passed.
- `pnpm run typecheck`: passed.
- EG targeted regression set: 6 files, 72 tests passed.
- `pnpm pipeline --input pipelines/baseline-check.json`: passed.
- `pnpm run validate`: passed, including `check:entity-governance`.
- `git diff --check`: passed.

## Review and delivery boundary

The implementation is ready for independent review. No external PR was
created in this mission because the user requested implementation and
verification, not external publication. PR creation remains a human-directed
delivery action.
