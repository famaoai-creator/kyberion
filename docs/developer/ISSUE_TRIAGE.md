---
title: Issue Triage
category: Developer
tags: [triage, maintenance, c-8]
importance: 7
last_updated: 2026-05-07
---

# Issue Triage

How incoming issues are processed. Phase C'-8 of `docs/PRODUCTIZATION_ROADMAP.md`.

## Cadence

- **Weekly triage**: every Monday, the on-call triager (rotation defined below) walks new and stale issues for ≤ 30 min.
- **Monthly contributor sync**: last Friday of the month, public via GitHub Discussions, ~ 30 min.
- **Quarterly maintainer review**: every 3 months, MAINTAINERS.md is reviewed and updated.

## Roles

| Role | Owner | Time commitment |
|---|---|---|
| Weekly triager | Rotates among triagers + area committers | ≤ 30 min/week |
| Monthly sync host | Core maintainer | ≤ 1 hr/month |
| Quarterly reviewer | All core maintainers | ≤ 1 hr/quarter |

If you'd like to join the triage rotation, see `MAINTAINERS.md` "Becoming a Maintainer" §1.

## Per-issue checklist

For each new issue:

1. **Label by area** — `area:browser` / `area:mission` / `area:voice` / `area:actuator` / `area:knowledge` / `area:docs` / `area:build`.
2. **Label by kind** — `bug` / `feature` / `docs` / `question` / `chore`.
3. **Label by severity** (bugs only) — `severity:critical` / `severity:high` / `severity:medium` / `severity:low`.
4. **Check for duplicates** — search closed + open issues. If duplicate: close with a link.
5. **Reproduce or ask for repro** — if the report lacks repro steps, comment with the [repro template](#repro-request-template).
6. **Add `good-first-issue` label** if the issue is:
   - small (≤ ~2 hr work),
   - well-scoped (clear definition of done),
   - touchable without deep system context,
   - ideally has tests already in the area.
7. **Assign or leave open** — assign to a willing committer; otherwise leave unassigned with a clear next-step comment.

## Per-PR checklist

For each new PR:

1. **CI green?** If failing, ask for fix.
2. **CODEOWNERS notified?** Verify the right reviewer was auto-assigned.
3. **Conventional commit title?** If not, request rename.
4. **Tests added?** For features and fixes, yes (unless obviously trivial).
5. **Docs updated?** For user-facing changes, yes.
6. **CHANGELOG entry?** If the change is user-visible, request a CHANGELOG addition under `[Unreleased]`.
7. **Stable surface change?** If yes, verify semver bump (manifest, contract-baseline) and request a +1 from another core maintainer.
8. **Review or hand off** within 7 days.

## Stale policy

- **Issues**: 90 days of no activity → bot tags `stale`. After 14 more days of no response, close with a "feel free to reopen" message.
- **PRs**: 30 days of no activity from author → comment requesting status. After 14 more days, close (PR can be reopened).

Stale automation is opt-in per repo and runs via `.github/workflows/stale.yml`.

## Repro request template

When asking for a reproducible test case, paste this comment:

```
Thanks for the report. To investigate I need a minimal reproduction:

- [ ] Kyberion version (`pnpm --version`, output of `git rev-parse HEAD`)
- [ ] Node version (`node --version`)
- [ ] OS + version
- [ ] Steps to reproduce, ideally a `pipelines/*.json` or `pnpm <command>` invocation
- [ ] What you expected vs. what happened
- [ ] `pnpm doctor` output

This helps us fix it without guessing. If the issue stops being reproducible, please close.
```

## Severity guide (bugs)

| Severity | Definition |
|---|---|
| **critical** | Breaks core flow for all users (build fails, mission-state corrupted, secrets leaked). Patch released within 7 days. |
| **high** | Breaks a major flow for many users (an actuator can't run, a primary surface is broken). Targeted for next minor. |
| **medium** | Reproducible bug with workaround, OR intermittent without clear repro. Targeted for next 2 minors. |
| **low** | Cosmetic, very-rare-edge-case, or works-as-designed-but-unintuitive. Best-effort. |

## Triage SLA

We aim for:

- Acknowledge within 7 days.
- Initial decision (accepted / needs-info / wontfix / duplicate) within 14 days.
- For `severity:critical`: acknowledge within 48 hours, fix in ≤ 7 days.

We may miss these — pre-1.0 — but they're the bar.

## What gets closed without action

- Spam / off-topic.
- Duplicates (closed with a link).
- "Add support for [proprietary thing] please" without offering implementation help — closed with a "PRs welcome" pointer.
- Reports that violate `CODE_OF_CONDUCT.md`.

## How to escalate

If you're a triager and an issue:

- Looks security-sensitive → close it (don't comment), redirect to `SECURITY.md`.
- Touches multiple areas → ping all relevant CODEOWNERS.
- Needs a roadmap-level decision → reply with "this is a roadmap question; opening a Discussion".

## See also

- [`MAINTAINERS.md`](../../MAINTAINERS.md) — who's on rotation.
- [`GOVERNANCE.md`](../../GOVERNANCE.md) — decision-making model.
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — what we expect from PR authors.
