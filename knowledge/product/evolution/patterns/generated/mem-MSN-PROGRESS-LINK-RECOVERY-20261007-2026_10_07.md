---
record_id: mem-MSN-PROGRESS-LINK-RECOVERY-20261007-2026_10_07
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PROGRESS-LINK-RECOVERY-20261007-2026_10_07
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-07T14:06:03.536Z
source_branch: feat/request-handoff-20261007
source_commit: a34d6d6bffff2b3a895e80ca07a3912f5120b74b
---

# Preserve explicit work identity across asynchronous navigation

Keep explicit work links bound to their intended target, clear stale scoped presentation, and preserve uncertain decision locks during navigation.

## Applicability

- mission
- mission:MSN-PROGRESS-LINK-RECOVERY-20261007

## Reusable Steps

1. Keep explicit work links bound to their intended target, clear stale scoped presentation, and preserve uncertain decision locks during navigation

## Expected Outcome

An explicit work identifier in a surface URL must resolve only inside the current authorized read model. When that target is unavailable, retain the URL and render a generic recovery notice instead of selecting another item. Defaults apply only when no explicit target is present; preserve established request-correlation compatibility deliberately.

A refresh or denied detail read must invalidate older responses and clear both rendered details and cached actionable rows. Removing only DOM nodes is insufficient because later filter or hash handlers can rebuild them. Pending and uncertain write locks must remain persisted until a current authoritative result resolves them.

Capture navigation scope after shared-rail normalization. Scope-changing history traversal must reinitialize cached preferences and permanently fence callbacks on the departing page, including successful late verdict responses that would otherwise start another read. Preserve denial status even when a gateway returns non-JSON content.

Regression coverage should include missing, encoded and malformed identifiers; hash/query collisions; target removal and reappearance; Back/Forward; read denial; stale detail responses; and late write callbacks during scope navigation. Source recovery should verify byte identity before reusing historical validation, while clearly distinguishing fresh checks.

## Evidence

- active/missions/public/MSN-PROGRESS-LINK-RECOVERY-20261007/evidence/design-spec.json
- active/missions/public/MSN-PROGRESS-LINK-RECOVERY-20261007/evidence/implementation-report.md
- active/missions/public/MSN-PROGRESS-LINK-RECOVERY-20261007/evidence/test-report.md

## Artifacts
