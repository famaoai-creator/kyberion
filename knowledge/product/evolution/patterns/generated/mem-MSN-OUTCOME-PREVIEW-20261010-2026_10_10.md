---
record_id: mem-MSN-OUTCOME-PREVIEW-20261010-2026_10_10
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-OUTCOME-PREVIEW-20261010-2026_10_10
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-10T05:41:04.589Z
source_branch: fix/outcome-preview-ownership-20261010
source_commit: 94eafe62023dc81ebee63412a8c38438bcfc0809
---

# Bind asynchronous previews to the current visible selection

Only the current visible selection, its artifact revision and its member-auth snapshot may publish preview data, errors or loading state; abort alone is not an ownership check.

## Applicability

- mission
- mission:MSN-OUTCOME-PREVIEW-20261010

## Reusable Steps

1. Only the current visible selection, its artifact revision and its member-auth snapshot may publish preview data, errors or loading state; abort alone is not an ownership check

## Expected Outcome

For asynchronous preview surfaces, select the entry synchronously and clear prior data before fetching. Keep Close usable while pending. Pair an AbortController with a generation guard for success, error, deadline and finalizer paths so an uncooperative request or delayed body cannot overwrite a newer selection or reopen a dismissed panel. Correlate receipt entry identity and retain selection only while its actual rendered queue entry, artifact revision and member-auth snapshot remain current. Derived display filters, deferral, failed parent reads, navigation and unmount are visibility boundaries. A current request whose auth was revoked must close rather than remain permanently busy; unavailable storage before dispatch should produce a dismissible error without a credential-free fallback. Bound requests and make retry explicit. Preserve an open preview across equivalent summary refreshes. Test delayed fetch/body/error delivery after Close, same-entry reopen, A/B reselection, visibility changes, auth revision changes and timeout. These client checks supplement server authorization and must not mutate browser history.

## Evidence

- active/missions/public/MSN-OUTCOME-PREVIEW-20261010/evidence/implementation-report.md
- active/missions/public/MSN-OUTCOME-PREVIEW-20261010/evidence/test-report.md
- active/missions/public/MSN-OUTCOME-PREVIEW-20261010/evidence/REVIEW-execution-implement.md

## Artifacts
