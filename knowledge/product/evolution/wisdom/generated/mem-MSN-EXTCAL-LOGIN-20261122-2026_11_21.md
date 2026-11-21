---
record_id: mem-MSN-EXTCAL-LOGIN-20261122-2026_11_21
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-EXTCAL-LOGIN-20261122-2026_11_21
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-21T22:35:18.904Z
source_branch: feat/external-calendar-credentials-20261122
source_commit: 145c9778af6d6da8554531f2e7c280f1ebc8f666
---

# Provider CLI 'status ok' is not 'can read': classify expired logins, and check risk side effects before reclassifying presets

A gws login can be present yet refused (revoked refresh token). Detect it from gws auth status token_valid:false plus a refusal token_error, show the re-login command, and never cache the expired answer. Declaring risk: read on a preset operation also removes agent approval gates, so it is a governance decision, not an error-reporting fix.

## Hint Scope

mission

## Trigger Phrases

- - `gws auth status` exits 0 and reports stored credentials even when Google refuses the refresh token (`invalid_grant`, shown as `token_valid: false` + `token_error: "Bad Request"`). Credential-file presence is not a signed-in check. `readGwsAuthStatus` projects `token_valid` and a boolean `token_refresh_failed` (refusal errors only: invalid_grant / bad request / unauthorized / revoked / expired / 400 / 401). Network and timeout errors are not refusals, and the error text is never kept.
- A surface that tells a person to sign in again and reload must not cache the expired state. Otherwise the reload still shows 'expired' for the cache TTL.
- Reproduce provider failures live before designing a fix. The earlier ROLE_VIOLATION hypothesis (personal connection document) did not reproduce on current main; the real blocker was the expired login.
- A failed CLI preset read surfaces as `ServiceEffectOutcomeUnknownError` when the operation declares no `risk: read`. Adding `risk: read` fixes that message, but it also makes the service-actuator and the tenant-binding contract treat the operation as approval-free for agents. Check every `risk === 'read'` consumer and get an operator decision before reclassifying.
- The personal-credential capability admits only single-route GET `type: api` bearer operations; it cannot carry a `gws` (CLI, session auth) call.

## Recommended References

- active/missions/public/MSN-EXTCAL-LOGIN-20261122/evidence/implementation-report.md
- active/missions/public/MSN-EXTCAL-LOGIN-20261122/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-EXTCAL-LOGIN-20261122/evidence/test-report.md

## Evidence

- active/missions/public/MSN-EXTCAL-LOGIN-20261122/evidence/implementation-report.md
- active/missions/public/MSN-EXTCAL-LOGIN-20261122/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-EXTCAL-LOGIN-20261122/evidence/test-report.md

## Artifacts
