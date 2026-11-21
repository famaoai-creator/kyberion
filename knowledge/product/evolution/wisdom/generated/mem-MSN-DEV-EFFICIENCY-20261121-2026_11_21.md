---
record_id: mem-MSN-DEV-EFFICIENCY-20261121-2026_11_21
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DEV-EFFICIENCY-20261121-2026_11_21
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-21T05:19:42.962Z
source_branch: feat/dev-efficiency-guards-20261121
source_commit: 9ce5a08d7fe8f7154ff08d73c9dec01ff5adb45d
---

# Waiting on CI before a governed action: pin the head and fake the CLI faithfully

A wait-for-CI-then-act step must pin the PR head before waiting and pass it to the action, and provider fakes must reproduce the CLI exit code and stderr for empty results (gh pr checks exits 1 with "no checks reported").

## Hint Scope

mission

## Trigger Phrases

- ## Rules

1. **Pin the head before waiting.** Providers report checks for the PR's current head, not a fixed commit. Read `headRefOid` first, wait with `vcsHostPrChecksWait`, then merge with `expectedHeadSha` (`vcsHostPrMergeWhenGreen`), so a push during the wait is refused instead of merged on the earlier green.
2. **Never act on the first checks read after creating a PR.** It is always pending; a one-shot read that refuses on pending never succeeds (the old `standard_pr_lifecycle` `auto_merge` did this). Wait for terminal states and fail closed on failure, timeout and zero checks.
3. **Fake the CLI, not just its payload.** `gh pr checks <pr> --json ...` exits 1 with empty stdout and stderr "no checks reported on the '<branch>' branch" when a PR has no checks. Treat that as `[]`; a fake that returns `[]` with exit 0 hides the bug.
4. **Validate URL refs against the bound repository.** A provider that reads only the PR number from a URL would act on the bound repository's PR of that number; compare the resolved PR url with the ref before waiting.
5. **Keep authority where it was.** Waiting is mechanics; the merge stays the governed `vcs:pr_merge` operation (approval, or a charter grant for the base branch).

## Recommended References

- active/missions/public/MSN-DEV-EFFICIENCY-20261121/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DEV-EFFICIENCY-20261121/evidence/retrospective.md
- active/missions/public/MSN-DEV-EFFICIENCY-20261121/evidence/test-report.md

## Evidence

- active/missions/public/MSN-DEV-EFFICIENCY-20261121/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DEV-EFFICIENCY-20261121/evidence/retrospective.md
- active/missions/public/MSN-DEV-EFFICIENCY-20261121/evidence/test-report.md

## Artifacts
