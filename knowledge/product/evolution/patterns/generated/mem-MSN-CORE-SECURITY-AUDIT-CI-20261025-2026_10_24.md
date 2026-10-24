---
record_id: mem-MSN-CORE-SECURITY-AUDIT-CI-20261025-2026_10_24
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CORE-SECURITY-AUDIT-CI-20261025-2026_10_24
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-24T20:06:38.754Z
source_branch: fix/core-security-audit-coverage-20261025
source_commit: ee238a7883d6cc61bbfd2b21abe4f8b8955c940f
---

# Validate repository security scans under coverage without weakening boundaries

Keep raw-import audits fresh and bounded, isolate leak checks, and bind storage assertions and verification claims to the actual checkout and source commit.

## Applicability

- mission
- mission:MSN-CORE-SECURITY-AUDIT-CI-20261025

## Reusable Steps

1. Keep raw-import audits fresh and bounded, isolate leak checks, and bind storage assertions and verification claims to the actual checkout and source commit

## Expected Outcome

Apply when a repository-wide security contract times out under main's coverage run while PR shards pass.

1. Compare the exact failing command, coverage mode and per-test deadline. Build one fresh raw-import inventory per audited root and derive both unauthorized imports and stale allowlist entries from it. Preserve every root, exclusion and reviewed exception, and reject orphan allowlist entries outside those roots.
2. Retain AST decoding for escaped specifiers and parse each actual filename for JSX/TSX. Stop traversal after a match and omit unused parent pointers. Do not replace the AST check with a plain-text fs prefilter or persist file verdicts across runs.
3. Run strict snapshot-based leak checks alone in their checkout; operational gates running concurrently can contaminate the report. Compare storage paths to the canonical scoped root, since an absolute worktree ancestor can itself contain active/shared.
4. Record subset assertion success separately from unchanged global coverage thresholds. Use full-core coverage to establish the global gate; reportOnFailure retains diagnostics without relaxing it. Record the tested commit/base, and after rebase distinguish earlier full-suite evidence from latest-base focused/build/readiness evidence.

Enforcement: libs/core/security-boundary.contract.test.ts and libs/core/knowledge/knowledge-feedback-loop.test.ts. Procedure: knowledge/product/governance/operations-hygiene-runbook.md section 5.

## Evidence

- active/missions/public/MSN-CORE-SECURITY-AUDIT-CI-20261025/evidence/implementation-report.md
- active/missions/public/MSN-CORE-SECURITY-AUDIT-CI-20261025/evidence/test-report.md
- active/missions/public/MSN-CORE-SECURITY-AUDIT-CI-20261025/evidence/full-core-first-run.md
- active/missions/public/MSN-CORE-SECURITY-AUDIT-CI-20261025/evidence/full-core-isolated-leaks.json

## Artifacts
