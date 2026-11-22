---
record_id: mem-MSN-FACTORY-RETRO-FIXES-20261122-2026_11_22
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-FACTORY-RETRO-FIXES-20261122-2026_11_22
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-22T07:08:57.955Z
source_branch: agent/factory-retro-fixes
source_commit: 5b0cba105bc0a011c7be3ca2c07798b27c0e9270
---

# Provider subagent tool vocabularies drift silently — probe the runtime registry before projecting

Generated provider agent definitions must be re-verified against the target CLI version: agy 1.5.x dropped 8 tool names that 1.4.x accepted (view_code_item etc.), failing at startup with unknown-component errors. Verify by invoking a single-tool probe agent per name; keep provider tool lists as a validated allowlist at the adapter boundary, and keep .agents/agents/ exclusively owned by the AGY projection since it is agy only custom-agent path.

## Hint Scope

mission

## Trigger Phrases

- Pilot #1 showed a generated subagent failing at startup because the adapter emitted a tool name the new agy registry no longer contains. Fixes that proved durable: (1) treat AGY_KNOWN_TOOLS as a runtime-verified allowlist and re-probe on version bumps (single-tool probe agent + short --print-timeout distinguishes resolve errors from model calls); (2) fresh worktrees need one bootstrap command (pnpm prepare:worktree = install + build:packages + build:repo) because verification commands run compiled output; (3) cross-worktree evidence writes belong behind --mission-root, validated as a same-repo worktree and confined to <root>/active/missions/** via the governed child-process writer (writePromotedFilesToWorktree), never by widening path validation.

## Recommended References

- active/missions/public/MSN-FACTORY-RETRO-FIXES-20261122/evidence/implementation-report.md
- active/missions/public/MSN-FACTORY-RETRO-FIXES-20261122/evidence/test-report.md

## Evidence

- active/missions/public/MSN-FACTORY-RETRO-FIXES-20261122/evidence/implementation-report.md
- active/missions/public/MSN-FACTORY-RETRO-FIXES-20261122/evidence/test-report.md

## Artifacts
