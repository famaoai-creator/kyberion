---
record_id: mem-MSN-DOT-TEAM-TEMPLATES-20261005-2026_10_05
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DOT-TEAM-TEMPLATES-20261005-2026_10_05
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T11:58:02.217Z
source_branch: feat/dot-team-templates
source_commit: 08be9d7b2cd48def3526bea419f7e9dce2d55c93
---

# Keep inactive dot presets distinct from runtime guarantees

Ship dot team candidates outside resident discovery and separate declared roles from activation, executor and budget guarantees verified in the actual runtime.

## Applicability

- mission
- mission:MSN-DOT-TEAM-TEMPLATES-20261005

## Reusable Steps

1. Ship dot team candidates outside resident discovery and separate declared roles from activation, executor and budget guarantees verified in the actual runtime

## Expected Outcome

## Reusable rule

An inactive team preset should reuse the existing DotCharter schema, registered roles and ownership model without changing active charters or adding execution authority. Keep candidate files outside runtime discovery with draft status and explicit operator activation.

## Runtime claims require source evidence

- Draft dot validate currently skips activation-readiness checks even when it prints activation_ready: true. Treat that as schema/loading evidence only; activation performs role, heartbeat and responsibility checks.
- Daily token_cap_per_day is a start threshold, not an exact total or currency ceiling. In-flight work may overshoot; cap-read failure can permit execution. Do not advertise a hard spending guarantee.
- A wake sees goal.statement, while a handed-off executor may receive only purpose plus the objective. Put critical independence, ownership and stop conditions in the handoff objective and concise purpose as well.
- Independent quality acceptance never authorizes publication, merge or deployment. Preserve existing operational owners and same-tenant handoff allowlists; template addition does not implement generic task execution or a notification aggregation router.

## Verification

Use schema/static envelope tests and independent inspection of current runtime call sites. Keep existing runtime/authority files unchanged for a data-only preset. Source implementation was remotely published and its complete tree verified before this record was promoted.

## Evidence

- active/missions/public/MSN-DOT-TEAM-TEMPLATES-20261005/evidence/implementation-report.md
- active/missions/public/MSN-DOT-TEAM-TEMPLATES-20261005/evidence/test-report.md
- active/missions/public/MSN-DOT-TEAM-TEMPLATES-20261005/evidence/independent-review.md

## Artifacts
