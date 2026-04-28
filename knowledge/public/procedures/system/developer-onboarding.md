---
title: Developer Onboarding Runbook
category: Procedure
tags: [onboarding, developer, runbook, first-week]
importance: 7
last_updated: 2026-04-27
---

# Developer Onboarding Runbook

For engineers joining a Kyberion deployment. The aim is to get from
`git clone` to "I shipped a small change end-to-end" within a week,
without bypassing the governance the rest of the system depends on.

This is a procedure (not architecture). Architecture lives under
[`knowledge/public/architecture/`](../../architecture/).

## Day 1 — local environment + first read

### Goals

- Repo cloned, `pnpm install`, root build green.
- Read the canonical concept in 30 minutes.
- Run a baseline check; understand what the 5 phases mean.

### Steps

1. Clone the repo and install:
   ```bash
   git clone <repo>
   cd kyberion
   pnpm install
   pnpm build
   ```
2. Read in this order, ≤ 5 minutes each:
   - [`AGENTS.md`](../../../../AGENTS.md) — operator rules (especially Rule 7)
   - [`docs/USER_EXPERIENCE_CONTRACT.md`](../../../../docs/USER_EXPERIENCE_CONTRACT.md)
   - [`knowledge/public/architecture/kyberion-canonical-concept-index.md`](../../architecture/kyberion-canonical-concept-index.md)
   - [`docs/INTENT_LOOP_CONCEPT.md`](../../../../docs/INTENT_LOOP_CONCEPT.md)
3. Run baseline:
   ```bash
   pnpm pipeline --input pipelines/baseline-check.json
   ```
   Match the `status` field to one of the five phases (recovery /
   onboarding / attention / all_clear / fatal_error).
4. Run the full validate suite. It must pass before you commit:
   ```bash
   pnpm run validate
   ```

### Done when

- [ ] `pnpm build` exits cleanly
- [ ] `pnpm run validate` is all green
- [ ] You can name the 6 stages of the intent loop without looking
- [ ] You know where `mission_controller` lives and what `tier-guard`
      does

## Week 1 — first mission, first PR

### Goals

- Pick something small (a typo fix, a missing test, a tiny new pipeline
  step). Drive it through the full mission lifecycle.
- Touch the audit chain and see your work land in `knowledge/incidents/`
  via `distill`.

### Steps

1. Choose a target. Good first picks:
   - A new contract test for an existing actuator
   - A new severity rule in `evaluateSimulationQuality`
   - A pipeline that wraps an existing CLI in a documented form
2. Create a mission:
   ```bash
   node dist/scripts/mission_controller.js create MSN-DEV-ONBOARD-<your-initials>
   node dist/scripts/mission_controller.js start MSN-DEV-ONBOARD-<your-initials>
   ```
3. Make your change. After every meaningful step:
   ```bash
   node dist/scripts/mission_controller.js checkpoint <task-id> "<note>"
   ```
4. Validate:
   ```bash
   pnpm run validate
   ```
5. Commit on your branch with a focused message. Run the test suite
   relevant to your area (e.g. `pnpm vitest run libs/core/...`).
6. Verify and distill:
   ```bash
   node dist/scripts/mission_controller.js verify MSN-DEV-ONBOARD-<initials> verified "first-week onboarding mission"
   node dist/scripts/mission_controller.js distill MSN-DEV-ONBOARD-<initials>
   ```
7. Open a PR (or, in the personal-repo workflow, produce the patch file
   per `update.patch` convention).

### Done when

- [ ] Your mission completes the lifecycle end-to-end
- [ ] `knowledge/incidents/distill_msn-dev-onboard-*.md` exists
- [ ] The audit chain shows your mission's create / activate / checkpoint
      / verify / distill events with hash continuity
- [ ] `pnpm run validate` passes

## Month 1 — fluency

### Goals

- Implement one new feature that touches at least three layers
  (e.g. a new actuator op + pipeline + mission class binding).
- Read every architecture doc once.
- Do one outcome simulation (`hypothesis-tree`) with `claude-cli` against
  a real decision in your team's roadmap and discuss the output.

### Suggested architecture reading order

Read each doc once, then come back to whichever maps closest to the
work you actually do.

1. [`kyberion-concept-evaluation-2026-04-26.md`](../../architecture/kyberion-concept-evaluation-2026-04-26.md) — Codex audit of the system
2. [`kyberion-intent-catalog.md`](../../architecture/kyberion-intent-catalog.md) — what users can ask for
3. [`kyberion-scenario-coverage-matrix.md`](../../architecture/kyberion-scenario-coverage-matrix.md) — what scenarios are covered
4. [`multi-tenant-operations.md`](../../architecture/multi-tenant-operations.md) — multi-tenant operations
5. [`operator-surface-strategy.md`](../../architecture/operator-surface-strategy.md) — UI strategy
6. [`mission-team-composition-model.md`](../../architecture/mission-team-composition-model.md) — how teams form
7. [`agent-mission-control-model.md`](../../architecture/agent-mission-control-model.md) — agent control plane

### Anti-patterns to recognize and avoid

| Anti-pattern | Why it bites | What to do instead |
|---|---|---|
| Direct `node:fs` write in a new module | tier-guard / audit-chain bypassed | Use `safeWriteFile` from `@agent/core/secure-io` |
| `auditChain.record` in MOS source | violates §9.1; CI fails | Route through `presence/displays/operator-surface/src/lib/audit-mos.ts` |
| Hardcoding org names in `knowledge/public/` | `pnpm run check:tier-hygiene` fails | Move to `knowledge/confidential/{tenant}/` and use placeholders |
| Skipping mission for "small" changes | Rule 7's 5-condition threshold | Start with mission for anything touching ≥2 conditions |
| Writing pipelines that bypass `wisdom:*` ops | inconsistent reasoning backend usage | Add the new op to `decision-ops.ts` and wire it through `dispatchDecisionOp` |
| Creating a new tier without updating policies | governance / hygiene checks miss it | Update `path-scope-policy.json`, `tier-hygiene-policy.json`, and `mission-classification-policy.json` together |

## When you get stuck

1. `pnpm pipeline --input pipelines/full-health-report.json` — surfaces
   most "is the system OK?" questions.
2. `pnpm pipeline --input pipelines/agent-provider-check.json` — checks
   reasoning-backend wiring.
3. `pnpm watch:tenant-drift` — multi-tenant integrity.
4. `git log` on a related actuator's `examples/*.json` — learn by
   imitation.
5. `knowledge/incidents/distill_*.md` — distilled lessons from prior
   missions.

If you hit something that should have been caught by validation but
wasn't, the rule of thumb: **add the test before fixing the bug.**

## What you should NOT do in your first month

- Touch `tier-guard.ts` or `secure-io.ts` without explicit pairing
  with someone who has merged a change there before.
- Add a new top-level directory under `knowledge/` or `active/`.
- Edit `AGENTS.md` Rule 7 without a documented rationale and dog-food
  evidence.
- Push secrets — even test secrets — to public-tier files.
  `pnpm run check:tier-hygiene` will catch this, but the rule comes
  first.

## Reference

- [`AGENTS.md`](../../../../AGENTS.md) — operator rules
- [`docs/INITIALIZATION.md`](../../../../docs/INITIALIZATION.md) — first-time setup
- [`docs/QUICKSTART.md`](../../../../docs/QUICKSTART.md) — quick start
- [`docs/COMPONENT_MAP.md`](../../../../docs/COMPONENT_MAP.md) — directory structure
- [`CAPABILITIES_GUIDE.md`](../../../../CAPABILITIES_GUIDE.md) — actuator catalog
