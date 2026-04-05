# Kyberion Operating Guide

Rules and lifecycle for AI agents working in this repository.

> **First-time setup**: See [docs/INITIALIZATION.md](./docs/INITIALIZATION.md).

## 1. Rules

These apply in every phase. No exceptions.

1. **All file I/O through `@agent/core/secure-io`.**
   Never use `node:fs` directly. Manage mission lifecycles (start, checkpoint, finish) via `scripts/mission_controller.ts` (KSMC v2.0). Each mission runs in its own Git repository for atomic rollback.

2. **Use existing Actuators first.**
   Screenshots, API calls, file conversions — check `libs/actuators/` before writing custom code. Temp files go in `active/shared/tmp/` or mission-local storage, not ad hoc directories.

3. **Get user approval for risky changes.**
   Architecture changes and destructive operations require explicit confirmation.

4. **Connect reasoning to execution via validated ADF.**
   The interface between agent decisions and Actuator execution is always a human-readable JSON contract (Agentic Data Format), but raw first-pass ADF is not executable by default. The required lifecycle is:
   `draft contract -> preflight validation -> auto-repair if safe -> committed executable contract -> execution`.
   Agents must prefer semantic briefs and governed compilers over writing low-level executable ADF directly.

5. **Enforce 3-tier data isolation.**
   `knowledge/personal/` (private), `knowledge/confidential/` (org-internal), `knowledge/public/` (reusable). No leaks from higher to lower tiers. Project-scoped isolation uses `confidential/{project}/`.

6. **One owner per mission.**
   Each mission has exactly one owner agent. Workers collaborate through task contracts — they do not mutate mission-wide state directly.

## 2. Lifecycle (5 Phases)

### Session Start Detection

Immediately on session start, run:

`pnpm pipeline --input pipelines/baseline-check.json`

Then transition by `status`:

1. `needs_recovery` → **② Recovery**
2. `needs_onboarding` → **① Onboarding**
3. `all_clear` (or other non-critical) → **③ Alignment**

### ① Onboarding
Set up the environment and user identity. `pnpm install` → `pnpm build` → identity configuration.
→ [phases/onboarding.md](./knowledge/public/governance/phases/onboarding.md)

### ② Recovery
Resume from interruptions. Restore prior state and continue from the suspension point.
→ [phases/recovery.md](./knowledge/public/governance/phases/recovery.md)

### ③ Alignment
Interpret user intent and define goals. Do not change code until goals are agreed upon.
→ [phases/alignment.md](./knowledge/public/governance/phases/alignment.md)

### ④ Execution
Change one thing at a time, test immediately. If a major obstacle arises, return to ③ to re-align.
The owner controls mission state. Workers participate via task contracts.
Before executing generated ADF or execution plans, run contract preflight and only execute validated contracts. Retry should happen after classification and repair, not by repeatedly sending broken contracts to actuators.
→ [phases/execution.md](./knowledge/public/governance/phases/execution.md)

### ⑤ Review
Extract learnings from both successes and failures into `knowledge/`. Clean up temp files. Auto-generate hints from execution Traces for future runs (Feedback Loop).
→ [phases/review.md](./knowledge/public/governance/phases/review.md)

## 3. References

| Document | Content |
|---|---|
| [docs/GLOSSARY.md](./docs/GLOSSARY.md) | Key terms |
| [docs/COMPONENT_MAP.md](./docs/COMPONENT_MAP.md) | Directory structure |
| [docs/QUICKSTART.md](./docs/QUICKSTART.md) | Quick start |
| [CAPABILITIES_GUIDE.md](./CAPABILITIES_GUIDE.md) | Actuator catalog |
| [docs/OPERATOR_UX_GUIDE.md](./docs/OPERATOR_UX_GUIDE.md) | Daily operations |
| [architecture/agent-mission-control-model.md](./knowledge/public/architecture/agent-mission-control-model.md) | Mission control model |
