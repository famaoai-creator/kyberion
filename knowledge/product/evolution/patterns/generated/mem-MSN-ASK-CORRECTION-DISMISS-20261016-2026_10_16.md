---
record_id: mem-MSN-ASK-CORRECTION-DISMISS-20261016-2026_10_16
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-ASK-CORRECTION-DISMISS-20261016-2026_10_16
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-16T21:26:41.981Z
source_branch: fix/ask-correction-dismissal-20261016
source_commit: 364ba71c1b15db685e447712f1b06260bd6ff85a
---

# Settle dismissed correction handoffs before accepting replacement drafts

Declining a URL-driven correction must consume only its current handoff, and replacement must recheck identity after cancellation changes that URL.

## Applicability

- mission
- mission:MSN-ASK-CORRECTION-DISMISS-20261016

## Reusable Steps

1. Declining a URL-driven correction must consume only its current handoff, and replacement must recheck identity after cancellation changes that URL

## Expected Outcome

Keeping an existing composer draft or pressing Escape is a completed decision about a correction suggestion. Clear the matching correction handoff parameters and obsolete notice while preserving the user's text, unrelated query parameters, and fragment. Otherwise sending the kept draft and reloading can silently restore the declined correction. Clear activation parameters through the existing accepted-handoff path; never automatically send or retry a request.

Bind dismissal callbacks to the current correction sequence, exact URL and verified viewer/conversation scope. Ignore callbacks after navigation, scope changes, a newer correction, or active sending. When replacing a proposal, canceling the previous proposal can change the URL; recheck the incoming proposal's identity after cancellation before showing or inserting it. A later explicit correction handoff must remain usable without a persistent dismissal registry. Test Keep and Escape equivalence, manual send then reload, Back/Forward, unrelated URL parameters, pending sends, stale callbacks, and a new explicit correction. Synthetic browser fixtures validate UI continuity, not live provider end-to-end execution.

## Evidence

- active/missions/public/MSN-ASK-CORRECTION-DISMISS-20261016/evidence/test-report.md
- active/missions/public/MSN-ASK-CORRECTION-DISMISS-20261016/evidence/browser-qa.json

## Artifacts
