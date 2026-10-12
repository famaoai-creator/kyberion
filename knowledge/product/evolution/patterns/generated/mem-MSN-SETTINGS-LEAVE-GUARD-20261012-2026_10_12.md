---
record_id: mem-MSN-SETTINGS-LEAVE-GUARD-20261012-2026_10_12
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-SETTINGS-LEAVE-GUARD-20261012-2026_10_12
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-12T19:13:20.701Z
source_branch: fix/settings-leave-guard-20261012
source_commit: f9f5657427d81ecbba0e5df61d6bb121f2eb7f71
---

# Deferred navigation must revalidate live draft and scope state

Treat a confirmed exit as a revocable intent: keep draft ownership local, check live save/context state before side effects, and separate app-navigation guarantees from browser-controlled unload warnings.

## Applicability

- mission
- mission:MSN-SETTINGS-LEAVE-GUARD-20261012

## Reusable Steps

1. Treat a confirmed exit as a revocable intent: keep draft ownership local, check live save/context state before side effects, and separate app-navigation guarantees from browser-controlled unload warnings

## Expected Outcome

# Deferred navigation must revalidate live draft and scope state

Use this pattern when a confirmation dialog delays navigation while a page owns unsaved edits.

## Invariants

- Keep the draft and its discard operation in the owning page. A shell-level guard stores callbacks and destination intent, not a second draft or persistent copy.
- Intercept navigation before changing a tenant/workspace cookie or any other scope side effect. Cancel must preserve URL, selection and draft.
- Confirmation is not authority to replay stale work. Immediately before continuing, recheck the live save-pending flag, draft/context validity, exact raw scope identity and selection generation. Normalized scope aliases can hide a personal/shared transition.
- A submitted save is not canceled by a leave dialog. Disable discard while it is pending. A clean save cancels pending navigation rather than silently leaving afterward.
- Consume an accepted intent once. Newer destinations supersede older ones; invalidation and unmount revoke pending callbacks.

## Preserve native navigation semantics

Allow same-document section hashes, modified/new-tab links and downloads without discarding the original page. Do not manufacture history sentinels or reverse-traversal loops to claim universal Back protection. Browser-controlled beforeunload warnings are a separate, best-effort layer and cannot guarantee app-controlled confirmation behavior.

## Verify distinct claims independently

Use source/integration tests for save races, exact-scope changes, once-only replay, clean transitions and unmount. Use actual browser checks for Keep/Discard/Escape, restored focus, superseded destinations, grouped drafts, section history and modified links.

If trusted input followed by native reload loses a draft without warning, record a failed native-warning check. Compare a minimal standard-handler fixture in the same browser with visible trusted-input and activation evidence. Matching failure supports an environment-specific observation, not an unproven browser-policy explanation. Do not label fake-event coverage as native dialog success.

## Evidence

- active/missions/public/MSN-SETTINGS-LEAVE-GUARD-20261012/evidence/implementation-report.md
- active/missions/public/MSN-SETTINGS-LEAVE-GUARD-20261012/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-SETTINGS-LEAVE-GUARD-20261012/evidence/test-report.md

## Artifacts
