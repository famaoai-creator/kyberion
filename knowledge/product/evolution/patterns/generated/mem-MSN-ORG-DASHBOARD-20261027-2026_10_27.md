---
record_id: mem-MSN-ORG-DASHBOARD-20261027-2026_10_27
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ORG-DASHBOARD-20261027-2026_10_27
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-27T03:36:01.283Z
source_branch: feat/organization-dashboard-20261027
source_commit: f4ed1e659104b74dc36688249c76666117e0a3bb
---

# Filter scoped dashboard records before aggregation and verify rendered browser metrics

Organization and personal work dashboards must reuse authenticated workspace scope and owner-tier visibility before computing counts, and browser verification must assert rendered labels and values.

## Applicability

- mission
- mission:MSN-ORG-DASHBOARD-20261027

## Reusable Steps

1. Organization and personal work dashboards must reuse authenticated workspace scope and owner-tier visibility before computing counts, and browser verification must assert rendered labels and values

## Expected Outcome

Resolve tenant, organization, project and information tier from the authenticated viewer on the server before counting records. A dashboard selection can only narrow that scope. Organization-wide views must reject project-limited viewers. Personal work must use the server-bound member ID and exact assignee_user_id match; never substitute role or principal labels. Client views must validate every consumed response field and withdraw stale rows on scope changes and failures. Build organization transitions from server-resolved parent selections so project-only URLs retain their authorized parents. Verify the compiled surface with actual Chromium and real authentication, API and approval-store paths inside a disposable product-policy-only synthetic root. Assert rendered metric names and values as well as API counts; token-key collisions and placeholder text can pass broad text assertions. Mobile checks must cover element bounds and document overflow. Always stop the owned server even when a browser close fails, await process exit, and only then remove fixture state.

## Evidence

- active/missions/public/MSN-ORG-DASHBOARD-20261027/evidence/test-report.md
- active/missions/public/MSN-ORG-DASHBOARD-20261027/evidence/implementation-report.md
- active/missions/public/MSN-ORG-DASHBOARD-20261027/evidence/REVIEW-execution-implement.md

## Artifacts
