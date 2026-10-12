---
record_id: mem-MSN-AGENT-SELECTION-20261012-2026_10_12
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-AGENT-SELECTION-20261012-2026_10_12
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-12T10:06:18.547Z
source_branch: feat/agent-selection-settings
source_commit: f02b10aa5f8aa06ef303ec77afebbc8c48ace703
---

# Fixed selection is an end-to-end dispatch contract

Treat fixed actor/provider/model selection as a scoped dispatch invariant, with canonical effective state, reviewed write authority, and honest verification evidence.

## Applicability

- mission
- mission:MSN-AGENT-SELECTION-20261012

## Reusable Steps

1. Treat fixed actor/provider/model selection as a scoped dispatch invariant, with canonical effective state, reviewed write authority, and honest verification evidence

## Expected Outcome

Apply this rule when adding manual actor or model selection. Keep actor identity separate from provider/model dimensions. Auto preserves legacy behavior; preferred may fall back with a disclosed reason; fixed rejects unavailable, unauthorized, incapable or review-dependent targets and must not cross a hidden fallback. Carry and revalidate the contract through staffing, prewarming, A2A, cached lifecycle instances, reasoning wrappers and concrete adapter requests. Test the actual final provider/model request with synthetic adapters, including enforcement conflicts and cross-role fallback.

Expose the persisted effective assignment separately from a newly ranked preview and current eligibility. Bind saves to a revision and preview decision token; guard work claims and runtime reservations so a setting cannot replace active ownership. Authenticate the administrator, check CSRF and canonical server scope, and enter a narrowly governed writer only after those checks. Register a new role in its canonical role directory and regenerate derived indexes; an index-only edit does not establish runtime authority. Verify positive save/reload and negative unrelated-path, traversal and symlink cases in a real isolated process.

Keep failed aggregate runs and subsequent focused corrections visible. A command exit code is not a health verdict: inspect structured status and circuit state. Rebuild after source formatting before readiness; an open recovery circuit requires the governed human decision rather than a state-file reset. Source-level UX review and unit assertions do not establish hosted browser or visual success; keep those results pending until actually observed.

## Evidence

- active/missions/public/MSN-AGENT-SELECTION-20261012/evidence/test-report.md
- active/missions/public/MSN-AGENT-SELECTION-20261012/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-AGENT-SELECTION-20261012/evidence/REVIEW-contract_authoring-ux-contract.md

## Artifacts
