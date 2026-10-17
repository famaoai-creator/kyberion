---
record_id: mem-MSN-ASK-BFCACHE-RECOVERY-20261017-2026_10_17
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-ASK-BFCACHE-RECOVERY-20261017-2026_10_17
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-17T07:46:49.384Z
source_branch: fix/ask-bfcache-recovery-20261017
source_commit: 99587ae9752ec93129046f6fb960e1f36f7cf1b1
---

# Restore cached pages through scoped reads without replaying submissions

Treat persisted pageshow as recovery of an old document, not a new submission or initial load.

## Applicability

- mission
- mission:MSN-ASK-BFCACHE-RECOVERY-20261017

## Reusable Steps

1. Treat persisted pageshow as recovery of an old document, not a new submission or initial load

## Expected Outcome

Applicable to retained-document form flows with asynchronous work.

On pagehide invalidate navigation scope and cancel queued recovery. On persisted pageshow synchronously retire old request, history and startup ownership before scheduling the scoped recovery read. Coalesce one recovery per hide, defer scoped GET until popstate/form restoration and current shell readiness, and reject stale sequences or scopes.

Preserve composer text and selection and persisted request ID; never automatically POST or apply URL prefill or historical actions. Retain explicit unconfirmed and reload controls even when the server pending count is zero or GET fails. Startup completion and retired POST finally must not unlock or overwrite newer attempts.

Test cached return before and after completion or timeout, failure, repeated events, scope changes, stale GET, shell replacement, and pageshow/popstate races; normal loads retain existing behavior. Browser fixtures demonstrate UI behavior, while server tests establish request-ID replay semantics. A missing local Playwright executable is an environment limitation, not a successful full gate; verify the remaining check in CI.

## Evidence

- active/missions/public/MSN-ASK-BFCACHE-RECOVERY-20261017/evidence/design-spec.json
- active/missions/public/MSN-ASK-BFCACHE-RECOVERY-20261017/evidence/browser-qa.md
- active/missions/public/MSN-ASK-BFCACHE-RECOVERY-20261017/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-ASK-BFCACHE-RECOVERY-20261017/evidence/test-progress.md

## Artifacts
