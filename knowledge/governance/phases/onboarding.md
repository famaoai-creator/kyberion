# Phase Protocol: ① Onboarding

## Goal
Environment safety verification and identity synchronization via physical manifestation.

## Directives
1. **Identity Integrity**: Verify the existence of `knowledge/personal/my-identity.json`. If missing, the Sovereign must manually inject their identity as the automated wizard is in legacy migration.
2. **Physical Infrastructure**: Ensure dependencies are managed via **pnpm**. `npm` is deprecated for this workspace due to `workspace:` protocol requirements.
3. **Governance Activation**: Trigger the "System Onboarding" job defined in `knowledge/governance/orchestration-config.json` using `scripts/run_orchestration_job.ts`.

## Execution Path [L1]
- **Action**: `npx pnpm install && npx tsx scripts/run_orchestration_job.ts`
- **Validation**:
  - Verification of `@agent/core` availability across all skills via symlink stabilization.
  - Confirmation of 3-Tier isolation and build artifact generation in `dist/`.

## Success Metrics [L3]
- **Status**: `scripts/run_orchestration_job.ts` returns `status: "finished"`.
- **Evidence**: `presence` services are active and reachable via `service_manager`.

---
*Status: Mandated by GEMINI.md*
*Last Updated: 2026-03-10 by Ecosystem Architect*
