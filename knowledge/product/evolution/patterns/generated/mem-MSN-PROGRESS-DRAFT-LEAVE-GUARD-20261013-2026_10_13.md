---
record_id: mem-MSN-PROGRESS-DRAFT-LEAVE-GUARD-20261013-2026_10_13
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-PROGRESS-DRAFT-LEAVE-GUARD-20261013-2026_10_13
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-13T14:10:51.389Z
source_branch: fix/progress-draft-leave-guard-20261013
source_commit: dba23ebcf735134c228380a4354af856f7e11671
---

# Guard app-controlled draft departures before context writes

Memory-only Progress correction drafts need an explicit app-owned departure choice, a shared latest-intent fence and separate unknown-outcome decision state.

## Applicability

- mission
- mission:MSN-PROGRESS-DRAFT-LEAVE-GUARD-20261013

## Reusable Steps

1. Memory-only Progress correction drafts need an explicit app-owned departure choice, a shared latest-intent fence and separate unknown-outcome decision state

## Expected Outcome

Same-page continuity does not protect a correction draft when a rail link, locale reload or workspace switch creates a new document. Keep draft ownership in the page; coordinate departures through a single optional requestLeave callback and the existing shared dialog. Use a safe primary Stay choice and destructive Discard-and-leave, with Escape equivalent to Stay and visible focus restoration.

Validate a target workspace with read-only GET before presenting the departure choice, but defer preference, URL and cookie writes until the current choice is confirmed. Track intent from the initial interaction, not just the eventual asynchronous response. Ordinary cross-document anchors must invalidate older context lookups even when the page is already clean. Returning to the current workspace or locale must cancel older intents without changing context. Recheck both the chosen intent and verified scope before executing a continuation, and allow it only once.

Classify actual navigation behavior: explicit same-document fragments and in-page filter/history changes stay uninterrupted, but fragment-less current-page and query-changing anchors may reload. Mark known attachment endpoints as downloads so they do not discard drafts without leaving. Modified clicks and non-self targets remain browser-owned.

Draft text, pending verdict writes and unknown-outcome identifier locks are different states. Explain the current state accurately; explicit departure may discard only in-memory draft content and must preserve existing scoped duplicate-submission locks. Do not retry or submit a verdict during navigation. A response settling while a dialog is visible must refresh or invalidate old copy. Renderer failures should keep the draft, show a visible recovery notice outside the dialog host and avoid a stale close resetting or focusing over a newer dialog.

Verify cancellation and confirmation with the actual shared renderer in a browser: initial focus, Tab trap, Escape, restored tenant/locale controls, same-page Back/Forward and explicit scoped departure. Tests cover asynchronous races, scope changes, failure cleanup and lock retention. Treat native reload, tab close, mobile behavior and real-provider outcomes as separate verification boundaries; do not promise universal draft recovery or add persistence implicitly.

## Evidence

- active/missions/public/MSN-PROGRESS-DRAFT-LEAVE-GUARD-20261013/evidence/browser-before.md
- active/missions/public/MSN-PROGRESS-DRAFT-LEAVE-GUARD-20261013/evidence/browser-after.md
- active/missions/public/MSN-PROGRESS-DRAFT-LEAVE-GUARD-20261013/evidence/test-report.md
- active/missions/public/MSN-PROGRESS-DRAFT-LEAVE-GUARD-20261013/evidence/REVIEW-execution-implement.md

## Artifacts
