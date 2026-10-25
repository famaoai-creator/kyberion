---
record_id: mem-MSN-MANAGED-TOOLS-20261025-2026_10_25
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-MANAGED-TOOLS-20261025-2026_10_25
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-25T13:08:39.362Z
source_branch: fix/managed-tool-runtimes-20261025
source_commit: f558b8787d2f72c0ace3a37bf6db64804224edf7
---

# Managed tool registration must separate installation, execution and readiness

A registered launch plan is not evidence of readiness; managed Python installations and subsequent execution must use the same tool-specific environment.

## Applicability

- mission
- mission:MSN-MANAGED-TOOLS-20261025

## Reusable Steps

1. A registered launch plan is not evidence of readiness; managed Python installations and subsequent execution must use the same tool-specific environment

## Expected Outcome

When adding an external tool, extend the canonical schema-backed tool runtime catalog and its index, declare supported platforms and optional dependency-group membership, and keep workspace/provider package version ownership with the existing descriptor. Use a read-only healthcheck rather than a trial that can download packages or generate artifacts. Scope uv pip installs with --python and uv tool installs with tool-specific directories; bind installed execution to the same managed interpreter or entrypoint. Reject disabled, unsupported and unknown runtime references before probing. Validate importer test files and a clean worktree build so unrelated checkout changes do not obscure registration defects.

## Evidence

- active/missions/public/MSN-MANAGED-TOOLS-20261025/evidence/distillation.md

## Artifacts
