---
record_id: mem-MSN-APPROVAL-CHANNELS-20261102-2026_11_02
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-APPROVAL-CHANNELS-20261102-2026_11_02
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-02T20:02:14.141Z
source_branch: feat/approval-channels-20261102
source_commit: 8e27c334f7b673d4b2bcb32a1690fc4cbfbc9b15
---

# Boundary gates need self-auditing escape hatches and comment/string-aware scanning

Static boundary gates that close a free-form vocabulary must (a) mask comments and string bodies before detecting call sites and slicing argument regions, (b) scan the whole repository rather than a fixed root list with a non-vacuous assertion, (c) audit allowlist entries for dangling/stale references, and (d) verify prefix families reject an empty suffix. Every escape hatch is the default failure mode.

## Applicability

- mission
- mission:MSN-APPROVAL-CHANNELS-20261102

## Reusable Steps

1. Static boundary gates that close a free-form vocabulary must (a) mask comments and string bodies before detecting call sites and slicing argument regions, (b) scan the whole repository rather than a fixed root list with a non-vacuous assertion, (c) audit allowlist entries for dangling/stale references, and (d) verify prefix families reject an empty suffix
2. Every escape hatch is the default failure mode

## Expected Outcome

When building a shrink-only static boundary gate (platform-facts, credential-req, authz-registry, approval-channels all follow this): tokenize-lite over the source so comments and string/template bodies cannot forge call sites or desynchronize balanced-delimiter slicing; resolve identifiers through const/let/var, reassignment, imports, re-exports, wildcard re-exports and import aliases; check template literals by requiring the static prefix to already contain a declared prefix (never the reverse direction); require dynamic-family prefixes to match a non-empty suffix; scan the entire repo minus build/test dirs instead of a hardcoded root list, and assert a minimum call-site count so the gate cannot pass vacuously; and make every allowlist self-auditing — fail on entries that no longer correspond to a live unresolved expression, because stale exemptions accumulate silently. Runtime measurement (warn-only, deduped, exception-safe sink) complements the static gate for values that are only knowable at runtime.

## Evidence

- active/missions/public/MSN-APPROVAL-CHANNELS-20261102/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-APPROVAL-CHANNELS-20261102/evidence/test-report.md
- active/missions/public/MSN-APPROVAL-CHANNELS-20261102/evidence/retrospective.md

## Artifacts
