---
record_id: mem-MSN-GRANT-READINESS-20261020-2026_10_19
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-GRANT-READINESS-20261020-2026_10_19
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-19T18:06:53.372Z
source_branch: feat/grant-readiness-20261020
source_commit: d896e9ebcb368acb646bf694221cb8f907d5ac8c
---

# External identifiers as grant keys: trust only provider-structured fields, namespace them, and gate every consumer

When a standing grant is matched by an identifier that arrives from an external system (calendar series ids, meeting links), an attacker-controllable field must never be able to widen what a human approved. Lessons from PG-06/07 (MSN-GRANT-READINESS-20261020).

## Applicability

- mission
- mission:MSN-GRANT-READINESS-20261020

## Reusable Steps

1. When a standing grant is matched by an identifier that arrives from an external system (calendar series ids, meeting links), an attacker-controllable field must never be able to widen what a human approved
2. Lessons from PG-06/07 (MSN-GRANT-READINESS-20261020)

## Expected Outcome

- Bind an external id to the data it came with. A calendar occurrence yields its recurring series id only when the meeting URL comes from the provider's conference field (Google hangoutLink, M365 onlineMeeting); a URL in free-text location/description is matched on its own. Otherwise an organizer can point one occurrence of a granted series at another meeting.
- Namespace ids by provider before they become grant keys (`google-workspace:<recurringEventId>`, `m365:<seriesMasterId>`), never accept an id the counterparty chooses freely (iCalendar UID), and reject un-namespaced ids at grant creation so a grant can never be silently unmatchable.
- A readiness/status check must evaluate the exact production gate in a read-only mode (here `checkMeetingParticipationConsent(..., record_binding: false)`), not a parallel re-implementation, so 'ready' and the real decision cannot drift.
- When adding a consumer of an id (series id into meeting:join), audit every path that acts on the data for a missing gate: the meeting actuator's join/listen had no recording-consent check at all.
- A step-level mission_id that disagrees with the ambient MISSION_ID is a conflict to deny, not an override.
- A notification's follow-up command must reproduce the window, tenant and calendars that produced it, or it lists nothing.
- Do not run `pnpm build` concurrently with a test suite in the same checkout: the dist rewrite produces spurious integration failures.

## Evidence

- active/missions/public/MSN-GRANT-READINESS-20261020/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-GRANT-READINESS-20261020/evidence/REVIEW-contract_authoring-ux-contract.md
- active/missions/public/MSN-GRANT-READINESS-20261020/evidence/test-report.md

## Artifacts
