---
record_id: mem-MSN-ORG-STATE-REPAIR-20261006-2026_10_06
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ORG-STATE-REPAIR-20261006-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T14:46:18.340Z
source_branch: main
source_commit: 17529cb2a131466b81a5293c09d011a52fa490a2
---

# Shared-scope organizations are not tenant-owned: writes need sovereign or an org-bound execution scope

MISSION_ROLE=organization_operator is tenant-bound (${KYBERION_TENANT}); active/organizations/<tier>/shared/ never matches it — interactive writes need KYBERION_PERSONA=sovereign. Delegated scopes can bind the org via shared/${KYBERION_ORGANIZATION_ID}/ grants (security-policy.json + role-write-access.json). Orgs missing organization-state.json flag organization_state:missing forever — repair via pnpm organization state ensure (idempotent).

## Applicability

- mission
- mission:MSN-ORG-STATE-REPAIR-20261006

## Reusable Steps

1. MISSION_ROLE=organization_operator is tenant-bound (${KYBERION_TENANT}); active/organizations/<tier>/shared/ never matches it — interactive writes need KYBERION_PERSONA=sovereign
2. Delegated scopes can bind the org via shared/${KYBERION_ORGANIZATION_ID}/ grants (security-policy
3. json + role-write-access
4. json)
5. Orgs missing organization-state
6. json flag organization_state:missing forever — repair via pnpm organization state ensure (idempotent)

## Expected Outcome

expandPolicyPath resolves ${KYBERION_TENANT} only for valid tenant slugs (shared/public rejected → no tenant grant); ${KYBERION_ORGANIZATION_ID} resolves only from currentExecutionScope().organizationId (delegation-bound, not env). Keep security-policy.json and role-write-access.json in sync — hand-maintained parallels.

## Evidence

- active/missions/public/MSN-ORG-STATE-REPAIR-20261006/evidence/implementation-report.md

## Artifacts
