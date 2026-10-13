---
record_id: mem-MSN-PROGRESS-READ-RECOVERY-20261013-2026_10_13
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-PROGRESS-READ-RECOVERY-20261013-2026_10_13
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-13T10:06:32.332Z
source_branch: fix/progress-read-recovery-20261013
source_commit: 0f03523e46692ed2ed8b50ae49c5467e2d836581
---

# Bound progress reads without weakening decision safeguards

Critical progress GETs need a deadline covering headers and body; denial headers remain authoritative and mutation uncertainty is a separate contract.

## Applicability

- mission
- mission:MSN-PROGRESS-READ-RECOVERY-20261013

## Reusable Steps

1. Critical progress GETs need a deadline covering headers and body; denial headers remain authoritative and mutation uncertainty is a separate contract

## Expected Outcome

Progress loading feedback is incomplete when a read can wait forever. Bound critical list, vocabulary and detail GETs across both response headers and JSON consumption, then reuse explicit localized recovery controls. The timeout must reject its own promise even if AbortController is absent or transport ignores abort; abort alone cannot guarantee a settled UI. Inspect non-success HTTP status before body parsing. Current detail 401/403/404 responses must clear cached presentation even when their bodies stall; list and vocabulary failures keep their existing generic recovery feedback. Keep sequence and scope fences around every continuation, retain the explicit request target, and ignore late old completions after recovery. Do not apply this read deadline to decision POSTs: a timed-out write may still commit and must retain its existing unknown-outcome lock and reconciliation behavior. Regression tests should exercise hung headers and body for each critical GET, repeated retry, distinctive stale payloads, no extra reads after late settlement, timer cleanup, authoritative denial, absent abort support, and a POST that remains locked beyond the read deadline. Verify the real page using clearly labeled GET-only synthetic adapters when live providers or authentication are unavailable, and distinguish that UI evidence from backend authorization coverage.

## Evidence

- active/missions/public/MSN-PROGRESS-READ-RECOVERY-20261013/evidence/distillation.md

## Artifacts
