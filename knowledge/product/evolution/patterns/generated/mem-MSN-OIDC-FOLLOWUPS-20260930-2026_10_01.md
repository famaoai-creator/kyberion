---
record_id: mem-MSN-OIDC-FOLLOWUPS-20260930-2026_10_01
kind: pattern
tier: public
knowledge_domain: product
owner_nhi:
candidate_id: mem-MSN-OIDC-FOLLOWUPS-20260930-2026_10_01
supersedes:
superseded_by:
project_id:
task_session_id:
specialist_id:
locale:
created_at: 2026-10-01T07:13:18.018Z
source_branch: fix/surface-auth-minor-20261001
source_commit: 5e3b60ac9905b82fea8f21d2e707913ad5cb014a
---

# Per-client rate limits need a distinguishable client — never pool unknown callers into one bucket

A per-client limiter whose key falls back to a constant (no trusted peer IP) becomes a global cap that one anonymous caller can exhaust, locking everyone out.

## Applicability

- mission
- mission:MSN-OIDC-FOLLOWUPS-20260930

## Reusable Steps

1. A per-client limiter whose key falls back to a constant (no trusted peer IP) becomes a global cap that one anonymous caller can exhaust, locking everyone out

## Expected Outcome

When a framework cannot supply a trustworthy peer address (e.g. Next.js 15+ has no request.ip and forwarded headers are spoofable without a trusted proxy), the per-client key degrades to a shared constant. A per-client cap on that key lets a single anonymous flood 429 every user. Apply only the whole-surface ceiling to indistinguishable callers, exempt proven loopback, evict least-recently-used buckets (not insertion-oldest) so key rotation cannot reset a hot client, and show a human-visible reason for any ignored state-changing GET such as a foreign /logout. Run the independent review before merge so such findings land in the same PR.

## Evidence

- active/missions/public/MSN-OIDC-FOLLOWUPS-20260930/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-OIDC-FOLLOWUPS-20260930/evidence/retrospective.md

## Artifacts
