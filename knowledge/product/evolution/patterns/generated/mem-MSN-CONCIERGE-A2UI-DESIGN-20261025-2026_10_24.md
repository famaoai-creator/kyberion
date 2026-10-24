---
record_id: mem-MSN-CONCIERGE-A2UI-DESIGN-20261025-2026_10_24
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CONCIERGE-A2UI-DESIGN-20261025-2026_10_24
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-24T16:47:49.013Z
source_branch: feat/concierge-a2ui-settings-20261025
source_commit: 20713c2873ce1d6953f7d9b27a76bd90830dbd67
---

# Accessible A2UI settings composition and honest visual evidence

Settings quality requires native navigation, explicit label associations, container-aware editing layouts and separate evidence for rendered appearance.

## Applicability

- mission
- mission:MSN-CONCIERGE-A2UI-DESIGN-20261025

## Reusable Steps

1. Settings quality requires native navigation, explicit label associations, container-aware editing layouts and separate evidence for rendered appearance

## Expected Outcome

Use grouped native links for settings navigation, preserve modifier clicks and stable section order, and retain drafts while moving between sections. Give each settings group a unique heading ID. Connect the visible row label to one supported input using explicit aria-labelledby while keeping help/error descriptions. Provide a full-width stacked layout for prose and stack narrow cards according to container width rather than viewport width alone. Validate catalog/schema registration and React/vanilla parity using realistic localized fixtures. Compare the complete application shell in light/dark and intermediate widths. Static HTML generation and passing DOM tests do not prove rendered visual quality; record approval-blocked browser checks as unverified. See knowledge/product/orchestration/a2ui-settings-design-playbook.md for the reusable procedure.

## Evidence

- active/missions/public/MSN-CONCIERGE-A2UI-DESIGN-20261025/evidence/implementation-report.md
- active/missions/public/MSN-CONCIERGE-A2UI-DESIGN-20261025/evidence/test-report.md
- active/missions/public/MSN-CONCIERGE-A2UI-DESIGN-20261025/evidence/REVIEW-contract_authoring-ux-contract.md

## Artifacts
