---
record_id: mem-MSN-BROWSER-DRAFT-CONSISTENCY-20261012-2026_10_12
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-BROWSER-DRAFT-CONSISTENCY-20261012-2026_10_12
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-12T17:15:54.934Z
source_branch: fix/browser-draft-consistency-20261012
source_commit: faf3a5efd273c83b37212b4e90de37d9b4e03fd5
---

# Keep browser request drafts consistent across shortcuts and delayed restoration

Treat every accepted editor update as the same draft operation; resolve shortcut conflicts only after a verified conversation draft is restored.

## Applicability

- mission
- mission:MSN-BROWSER-DRAFT-CONSISTENCY-20261012

## Reusable Steps

1. Treat every accepted editor update as the same draft operation; resolve shortcut conflicts only after a verified conversation draft is restored

## Expected Outcome

Apply this pattern when a request composer combines typed input, starter shortcuts, URL prefill and asynchronous history restoration.

1. Register local edit tracking before asynchronous initialization. Track intentional clearing as an edit. Restore saved text only when no newer local edit exists, and persist early edits after the server-provided conversation identity is verified.
2. Use one editor update and persistence path for accepted shortcuts. Keep current text unchanged while the user chooses whether to replace it; cancellation and Escape restore predictable editor focus and selection. Disable shortcut choices while existing draft ownership is unknown.
3. Keep unhandled nonsending URL prefill recoverable when history or storage verification fails. On the first successful retry, restore any untouched saved draft before evaluating the candidate. Do not change explicit-send behavior, request identifiers, uncertain retry metadata or read-only resume boundaries.
4. Test reload, navigation, delayed history, clearing, failure then retry, storage failure and repeated choices. Distinguish deterministic DOM race tests from actual browser evidence.

Actual browser verification covered shortcut choices, reload, settings navigation and Back/Forward; a cramped preview layout was found and corrected. Delayed-history and corrupt-storage cases were verified by deterministic tests, not by forced real-browser failures.

## Evidence

- active/missions/public/MSN-BROWSER-DRAFT-CONSISTENCY-20261012/evidence/implementation-report.md
- active/missions/public/MSN-BROWSER-DRAFT-CONSISTENCY-20261012/evidence/test-report.md
- active/missions/public/MSN-BROWSER-DRAFT-CONSISTENCY-20261012/evidence/REVIEW-execution-implement.md

## Artifacts
