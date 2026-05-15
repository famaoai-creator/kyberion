---
title: Production Evidence Collection Runbook
category: Operator
tags: [production-readiness, evidence, operations, fde]
importance: 9
last_updated: 2026-05-15
---

# Production Evidence Collection Runbook

This runbook defines how operators collect and review the non-local evidence required before Kyberion can be called production-ready. The canonical machine-readable register is
`knowledge/public/governance/production-evidence-register.json`; the developer-facing summary is
[`../developer/PRODUCTION_EVIDENCE_REGISTER.ja.md`](../developer/PRODUCTION_EVIDENCE_REGISTER.ja.md).

Do not mark an item `verified` until the artifact exists, the reviewer has checked it, and the register contains `reviewed_at`, `reviewer`, and at least one `evidence_refs` entry.
Each `evidence_refs` entry must be either an `http(s)` URL or a repo-local path that exists at review time.
For repo-local paths, the reviewer should verify the file or directory is present before flipping `status` to `verified`.

## Commands

```bash
pnpm run validate
pnpm run check:production-evidence-status
pnpm run check:production-evidence-complete
```

`check:production-evidence-status` is the daily status check and succeeds while evidence is pending. `check:production-evidence-complete` is the release-promotion gate and must fail until every item is reviewed and `verified`.

## EV-30DAY-OPS

Purpose: prove Roadmap D2 / Phase B acceptance: one real user environment can run Kyberion for 30 days with primary scenario success rate at least 95%, human intervention at most 1 per week, and unknown error rate at most 10%.

Collection protocol:

1. Pick one operator-owned environment and record its OS, Node, pnpm, reasoning backend, and enabled actuators.
2. Run `pnpm run doctor` at the start of the window and save the output in an operator-controlled run log.
3. Run the representative scenario set daily: `pnpm pipeline --input pipelines/baseline-check.json`, `pnpm pipeline --input pipelines/verify-session.json`, and the use-case-specific mission or pipeline.
4. Preserve trace artifacts under `active/shared/logs/traces/` and screenshots or temporary proof under `active/shared/tmp/`.
5. Record every manual intervention with timestamp, cause, remediation, and whether it was operator error, known runtime gap, or unknown error.
6. At day 30, summarize total runs, success rate, interventions per week, unknown error rate, and incident links.

Minimum evidence refs:

- 30-day run summary using [`templates/production-evidence-30day-ops.md`](./templates/production-evidence-30day-ops.md) or a linked operator-controlled artifact with the same fields.
- Trace files or trace bundle covering the window.
- Incident summary, including a statement when there were no incidents.

## EV-EXT-CONTRIB

Purpose: prove Roadmap D5 / Phase C' acceptance: an external contributor can take a good-first-issue from issue to merge in one week.

Collection protocol:

1. Open or select an issue that follows `.github/ISSUE_TEMPLATE/good-first-issue-guide.md`.
2. Confirm the task points to `CONTRIBUTING.md`, `docs/developer/GOOD_FIRST_ISSUES.md`, and the targeted test command.
3. Confirm the contributor is external to the maintainer team.
4. Record issue open date, first contributor comment date, PR open date, review date, and merge date.
5. Record which docs were unclear or missing; file follow-up issues if needed.

Minimum evidence refs:

- GitHub issue URL.
- GitHub PR URL.
- Review or merge record showing the contribution merged within 7 days of contributor start.
- Completed [`templates/production-evidence-external-contribution.md`](./templates/production-evidence-external-contribution.md) or equivalent notes.

## EV-FDE-DEPLOY

Purpose: prove Roadmap Phase D' acceptance: an external FDE or SI can complete one customer deployment without forking Kyberion.

Collection protocol:

1. Start from [`DEPLOYMENT.md`](./DEPLOYMENT.md) and choose macOS, Linux, or Docker.
2. Create or reuse a customer overlay with `pnpm customer:create <slug>` and record the overlay paths used.
3. Run `pnpm customer:switch <slug>`, source `active/shared/runtime/customer.env`, and complete `pnpm onboard`.
4. Run `pnpm run doctor`, the relevant runtime-specific doctor command, and the customer scenario mission or pipeline.
5. Record every place where the FDE/SI needed code changes. The item cannot be verified if a fork or product patch was required for deployment.
6. Write a deployment summary with environment, customer overlay, commands run, artifacts produced, unresolved gaps, and postmortem notes.

Minimum evidence refs:

- Deployment summary or postmortem using [`templates/production-evidence-fde-deployment.md`](./templates/production-evidence-fde-deployment.md) or equivalent notes.
- Customer overlay evidence with secrets excluded.
- Mission, pipeline, trace, or screenshot artifacts proving the deployment scenario ran.
- Statement that no fork was required, or a rejected status explaining why verification is blocked.

## Promotion Update

After evidence review:

1. Update `knowledge/public/governance/production-evidence-register.json`.
2. Mirror the status in `docs/developer/PRODUCTION_EVIDENCE_REGISTER.ja.md`.
3. Run `pnpm run check:production-evidence-status`.
4. Run `pnpm run check:production-evidence-complete` only when all items are expected to be verified.
5. Update `docs/developer/PRODUCTION_RELEASE_GATE_AUDIT.ja.md` if the release decision changes.
