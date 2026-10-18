---
record_id: mem-MSN-CODEX-READONLY-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CODEX-READONLY-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T10:49:39.988Z
source_branch: fix/codex-readonly-20261018
source_commit: 49e90dfaabab3076c91ac45e9ba614d176972e6d
---

# Propagate explicit Codex read-only constraints before CLI dispatch

A reasoning adapter must carry explicit capability and permission constraints to the provider boundary, reject contradictory or unsupported requests before dispatch, and preserve ambient narrowing without silently changing legacy defaults.

## Applicability

- mission
- mission:MSN-CODEX-READONLY-20261018

## Reusable Steps

1. A reasoning adapter must carry explicit capability and permission constraints to the provider boundary, reject contradictory or unsupported requests before dispatch, and preserve ambient narrowing without silently changing legacy defaults

## Expected Outcome

## Problem

CodexCliReasoningBackend.delegateTask previously selected workspace-write unconditionally and did not propagate explicit profile, capability_profile, or permission_mode options. A caller requesting a read-only task could therefore lose that constraint before the CLI query.

## Reusable procedure

1. Resolve and validate explicit profile aliases before provider dispatch. Unknown profiles, conflicting aliases, unsupported modes, and unsupported tool-less planner profiles fail closed.
2. Treat readonly as a narrowing constraint: use the existing explorer profile. An edit request must not widen an explicit explorer profile. Preserve ambient read-only execution context.
3. Pass both the resolved profile and corresponding sandbox mode to the CLI query. Preserve historical defaults only when no explicit or ambient constraint exists; routing metadata is not authority.
4. Enforce the contract with mocked adapter tests for delegateTask and prompt, negative combinations, ambient constraints, and preservation of model, effort, and cancellation options. Pair those tests with downstream argv/profile tests.

## Evidence and limits

The fix passed 70 mocked provider/query/permission tests, lint, formatting, typechecks, a full build, and 48 PR-readiness gates. The 70 tests and focused static gates passed again after integration with current main. Read-only restricts filesystem writes; it does not itself mean tool-less execution. Native app-server paths were unchanged. A separate bounded live experiment failed during startup with EROFS before producing an answer; this adapter fix does not repair runtime storage or prove successful autonomous execution or Web integration.

## Evidence

- active/missions/public/MSN-CODEX-READONLY-20261018/evidence/implementation-report.md
- active/missions/public/MSN-CODEX-READONLY-20261018/evidence/test-report.md
- active/missions/public/MSN-CODEX-READONLY-20261018/evidence/REVIEW-execution-implement.md

## Artifacts
