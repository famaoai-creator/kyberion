---
record_id: mem-MSN-RESIDENT-DOT-AUTONOMY-20261004-2026_10_04
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-RESIDENT-DOT-AUTONOMY-20261004-2026_10_04
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-04T06:44:32.267Z
source_branch: feat/resident-dot-autonomy-20261004
source_commit: bde54a61089213983f0ba6c0df974d643490c233
---

# Governing agent proposals: derive the policy action from the effect, count only human trust

When an autonomous agent (resident dot) feeds proposals into the autonomous-ops gate, the gate is only as strong as the labels it scores. Derive the policy action from the effect, score same-effect actions identically, re-earn trust only from human deciders, and make parked-decision settlement idempotent.

## Applicability

- mission
- mission:MSN-RESIDENT-DOT-AUTONOMY-20261004

## Reusable Steps

1. When an autonomous agent (resident dot) feeds proposals into the autonomous-ops gate, the gate is only as strong as the labels it scores
2. Derive the policy action from the effect, score same-effect actions identically, re-earn trust only from human deciders, and make parked-decision settlement idempotent

## Expected Outcome

Lessons from MSN-RESIDENT-DOT-AUTONOMY-20261004 (independent review found these after the first implementation passed all tests):

1. Never let the proposing agent choose the policy action id. If it can name any action in autonomous-ops-policy.json it can pick a cheaper or shadow action and escape per-action floors. Derive the id from the requested effect (dot_handoff when handoff_to is set, else dot_delegate_work) and refuse anything else at the enforcement point.
2. Actions with the same effect must score the same. A handoff that creates the same ready WorkItem as a delegation must not score lower, or two cooperating agents launder work through it.
3. Learned floors (raise to approve after an operator rejection) must be keyed on the agent, not the action label, and released only by approvals with decidedByType human. Veto-window silence (policy:veto-window) and ai_agent/service deciders are not re-earned trust.
4. A notify verdict becomes a veto card only when a veto window exists; give agent actions a policy veto_window_minutes instead of relying on each charter.
5. Settling parked decisions must be idempotent: one feedback row per action_ref, reuse an existing WorkItem by metadata.action_ref, leave the action parked when its approval record cannot be read (decline only a confirmed-missing record), and re-check charter scope before executing an approval that waited.
6. Tests that clear a shared store channel interfere across parallel vitest workers; the approval store vitest root is per worker (vitest-approvals/pool-<VITEST_POOL_ID>).
7. Passing tests are not a review: spawn an independent reviewer subagent for governance code before shipping.

## Evidence

- active/missions/public/MSN-RESIDENT-DOT-AUTONOMY-20261004/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-RESIDENT-DOT-AUTONOMY-20261004/evidence/REVIEW-contract_authoring-ux-contract.md
- active/missions/public/MSN-RESIDENT-DOT-AUTONOMY-20261004/evidence/design-spec.json

## Artifacts
