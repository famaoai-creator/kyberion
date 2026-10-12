---
record_id: mem-MSN-BROWSER-FLOW-CONTINUITY-20261012-2026_10_12
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-BROWSER-FLOW-CONTINUITY-20261012-2026_10_12
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-12T15:04:51.622Z
source_branch: feat/browser-flow-continuity-20261012
source_commit: 469e6dc419bc8ca71562733a699e78249df40b7c
---

# Preserve browser intent through URL history and asynchronous layout

Keep explicit list or section choices in the URL while preserving stronger item targets, authorization scope, and user control during delayed layout.

## Applicability

- mission
- mission:MSN-BROWSER-FLOW-CONTINUITY-20261012

## Reusable Steps

1. Keep explicit list or section choices in the URL while preserving stronger item targets, authorization scope, and user control during delayed layout

## Expected Outcome

# Browser navigation continuity

- Treat a chosen section or list filter as navigation state. Push only changed explicit choices; replay and canonicalization must not add history. Preserve framework history state and scope parameters.
- Preserve item-link precedence: a decodable explicit item remains the target even when unavailable; request correlation may resolve only without a decodable item. An explicit list-tab choice clears old item/request targeting while Back retains the original targeted URL. Never silently select unrelated default work for an explicit filter or missing target.
- Invalidate pending detail responses when the list target changes. Keep scope-change full reload and uncertain-write fences independent of presentation state.
- Restore section anchors after their DOM exists, and account for independently loaded content above them. Re-anchor during initial layout changes only while the user has not taken control; disconnect on wheel, touch, pointer, keyboard input and unmount. Resize recovery must not move focus.
- Include nested sections in deterministic viewport selection. Callback-local intersection subsets can mislabel the current section.
- Verify with both synthetic delayed-layout/stale-response tests and a production-built real browser. In this case the browser found a 200px initial deep-link drift that click-only tests missed; the rebuilt initial/reload flow and manual wheel control were independently retested.

Evidence interpretation: automated and browser checks establish the bounded UI behavior. Offline stub distillation is a deterministic extraction aid, not a live model review or a full authenticated execution test.

## Evidence

- active/missions/public/MSN-BROWSER-FLOW-CONTINUITY-20261012/evidence/test-report.md
- active/missions/public/MSN-BROWSER-FLOW-CONTINUITY-20261012/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-BROWSER-FLOW-CONTINUITY-20261012/evidence/REVIEW-contract_authoring-ux-contract.md

## Artifacts
