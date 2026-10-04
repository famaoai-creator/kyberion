---
record_id: mem-MSN-SURFACE-EXPERIENCE-20261004-2026_10_04
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-SURFACE-EXPERIENCE-20261004-2026_10_04
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-04T15:24:43.009Z
source_branch: fix/surface-continuity-20261004
source_commit: 3596a3eb39ed64fbd11f99e2aa2c883745179a49
---

# Preserve scope and uncertain outcomes across conversational surfaces

A shared front desk needs server-owned scope identity, bounded completed context, and durable uncertainty receipts. Preserve existing transcript identities; distinguish proven admission rejection from unknown execution; retain cleanup ownership until a runtime is actually stopped.

## Applicability

- mission
- mission:MSN-SURFACE-EXPERIENCE-20261004

## Reusable Steps

1. A shared front desk needs server-owned scope identity, bounded completed context, and durable uncertainty receipts
2. Preserve existing transcript identities; distinguish proven admission rejection from unknown execution; retain cleanup ownership until a runtime is actually stopped

## Expected Outcome

Apply this pattern when multiple UI surfaces share conversations, request retries, or result decisions.

1. Derive the conversation identity from authenticated principal and the full allowed/selected tenant, organization, project and tier projection. Validate explicit narrowing on the server. Preserve legacy hash field order and transcript paths with a literal golden fixture. Client request IDs correlate work but must never select an owner or namespace inherited pending state globally.

2. Restore only bounded completed user/reply pairs as untrusted model context. Do not replay historical approval metadata or route old text as a fresh command. If a backend cannot carry the full authorized scope, return an explicit unsupported outcome rather than falling back to a shared unscoped executor.

3. Bind new retry reservations to the raw input digest before redaction or truncation. Use server reservation time for receipt retention, separately from client-issued freshness checks. A pending or unknown outcome must not start a second execution. Only a typed pre-execution rejection plus a successfully persisted not-started receipt can permit a same-ID retry. State the retention window and eviction behavior instead of promising unlimited exactly-once delivery.

4. Runtime cleanup must own partially booted adapters, await pending spawn completion, and require an explicit stopped acknowledgement. Failed cleanup retains admission. A live-supervisor concurrency cap is not a crash-proof global process budget. Fresh per-turn runtimes preserve base manifest/policy/NHI authority while isolating model context; they add startup overhead and do not create durable background execution.

5. Persist browser decision uncertainty before POST, scoped to principal and item identity. A GET begun before an ambiguous write cannot clear that marker. Resolve only from later exact terminal evidence, and fail closed when saved marker reads or validation fail. Client guards do not repair a non-idempotent backend. Validate both ends of artifact/task associations and filter inbox joins by the same selected scope.

6. Test interruption boundaries explicitly: colliding redacted input, backdated reservation timestamps, overlapping same-ID requests, incomplete lock publication and competing reclaimers, boot/stop races, stale reads, malformed storage and cross-scope associations. Report source review, mocked/DOM tests, real transport tests and visual verification separately. Readiness should rely on health evidence rather than an enabled flag, with one actionable blocking next step.

## Evidence

- active/missions/public/MSN-SURFACE-EXPERIENCE-20261004/evidence/distillation.md
- active/missions/public/MSN-SURFACE-EXPERIENCE-20261004/evidence/implementation-report.md
- active/missions/public/MSN-SURFACE-EXPERIENCE-20261004/evidence/test-report.md
- active/missions/public/MSN-SURFACE-EXPERIENCE-20261004/evidence/REVIEW-execution-implement.md

## Artifacts
