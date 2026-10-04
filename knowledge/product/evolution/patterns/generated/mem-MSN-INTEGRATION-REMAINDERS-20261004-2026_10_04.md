---
record_id: mem-MSN-INTEGRATION-REMAINDERS-20261004-2026_10_04
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-INTEGRATION-REMAINDERS-20261004-2026_10_04
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-04T05:47:30.669Z
source_branch: fix/device-abstraction-20261004
source_commit: bde54a61089213983f0ba6c0df974d643490c233
---

# Device extension contracts require routing and real-device evidence

Separate platform input arguments from orchestration and verify the actual selected device.

## Applicability

- mission
- mission:MSN-INTEGRATION-REMAINDERS-20261004

## Reusable Steps

1. Separate platform input arguments from orchestration and verify the actual selected device

## Expected Outcome

Camera and audio adapters own platform arguments and enumeration. Unknown or ambiguous explicit selections must fail. Audio selection must route through the bus before open. Supplemental inventory providers supply device identities. OCR has a total deadline and cancellation signal, with cooperative provider cancellation. Native camera verification is required because device-supported frame rates can differ from tool defaults.

## Evidence

- active/missions/public/MSN-INTEGRATION-REMAINDERS-20261004/evidence/design-spec.json
- active/missions/public/MSN-INTEGRATION-REMAINDERS-20261004/evidence/implementation-plan.json

## Artifacts
