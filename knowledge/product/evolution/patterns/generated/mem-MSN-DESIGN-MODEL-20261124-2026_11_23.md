---
record_id: mem-MSN-DESIGN-MODEL-20261124-2026_11_23
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DESIGN-MODEL-20261124-2026_11_23
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-23T22:07:53.126Z
source_branch: feat/shared-design-model-20261124
source_commit: bb7ec217817c7d1715e00a35a46ef8a654464d4d
---

# Verify design precedence with mixed input paths

Exercise both legacy and explicit tenant inputs when consolidating design resolution.

## Applicability

- mission
- mission:MSN-DESIGN-MODEL-20261124

## Reusable Steps

1. Exercise both legacy and explicit tenant inputs when consolidating design resolution

## Expected Outcome

When two design resolvers converge, add a regression fixture with a valid public design system and an existing tenant palette and logo. Run the fixture through the legacy input and again with an explicit tenant slug. Assert that tenant branding remains in scope and that the applied base theme identity can be distinguished from style and tenant overlays.

## Evidence

- active/missions/public/MSN-DESIGN-MODEL-20261124/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DESIGN-MODEL-20261124/evidence/retrospective.md

## Artifacts
