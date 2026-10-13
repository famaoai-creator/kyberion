---
record_id: mem-MSN-FRONT-DESK-SHELL-RECOVERY-20261013-2026_10_13
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-FRONT-DESK-SHELL-RECOVERY-20261013-2026_10_13
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-13T08:52:18.307Z
source_branch: fix/front-desk-shell-recovery-20261013
source_commit: edf16c8683a007e33de348aede68e440f369a75d
---

# Recover browser shell reads without releasing stale readiness

Separate bounded read attempts from success-only shell readiness, preserve drafts, and fence both successful and failed asynchronous continuations by mount and scope.

## Applicability

- mission
- mission:MSN-FRONT-DESK-SHELL-RECOVERY-20261013

## Reusable Steps

1. Separate bounded read attempts from success-only shell readiness, preserve drafts, and fence both successful and failed asynchronous continuations by mount and scope

## Expected Outcome

## Problem

A shared browser shell can leave every dependent page waiting forever when identity or navigation reads never settle. Swallowing those failures can instead release page initialization with unverified client context. A retry must not replay a mutation or release an older page mount.

## Reusable implementation rule

Give each shell mount a success-only readiness promise and each read attempt a bounded lifetime covering headers and JSON body. Explicit GET retry reuses the current readiness waiter and remains single-flight; a replacement mount abandons older waiters. Validate identity and navigation response structure before rendering or resolving readiness. Classify 401 and 403 before consuming the response body, expose distinct sign-in/access guidance, and abort failed reads. Preserve server-approved no-tenant semantics by clearing stale tenant/project preferences rather than retaining an earlier selection.

Fence the attempt generation and normalized tenant/organization/project context again after every asynchronous boundary, including optional message loading and rendering. Ask/Progress startup consumers capture readiness and guard both success and rejection paths; an old rejection must not erase a newer result. SSR-localized recovery markup supports bounded loading and blocked guidance while preserving existing draft inputs. A blocked shell should show an actionable reason rather than an endless loading label.

## Verification pattern

Test fetch and body hangs, malformed JSON/network failures, unread 401/403 bodies, double-clicked retry, no-tenant normalization, late success after timeout, superseded mounts/scopes, and stale vocabulary rejection. Check exact rendered result identity when testing stale rejection. Compare healthy, failed and recovered states using actual page source with GET-only synthetic adapters. Such browser evidence verifies client behavior and does not establish live OIDC or backend authorization coverage.

## Scope

This lesson concerns front-desk client initialization and read recovery. It does not change server authorization, introduce automatic mutation retry, or claim equivalent continuation guards for every page.

## Evidence

- active/missions/public/MSN-FRONT-DESK-SHELL-RECOVERY-20261013/evidence/distillation.md
- active/missions/public/MSN-FRONT-DESK-SHELL-RECOVERY-20261013/evidence/browser-evaluation.md
- active/missions/public/MSN-FRONT-DESK-SHELL-RECOVERY-20261013/evidence/implementation-report.md
- active/missions/public/MSN-FRONT-DESK-SHELL-RECOVERY-20261013/evidence/test-report.md
- active/missions/public/MSN-FRONT-DESK-SHELL-RECOVERY-20261013/evidence/REVIEW-execution-implement.md

## Artifacts
