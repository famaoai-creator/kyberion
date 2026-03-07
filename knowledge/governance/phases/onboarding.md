# Phase Protocol: ① Onboarding

## Goal
Environment safety verification and identity synchronization.

## Directives
1. **Identity Check**: Verify the existence and integrity of `knowledge/personal/my-identity.json`.
2. **Tier Verification**: Ensure the 3-Tier directory structure (Personal, Confidential, Public) is correctly established.
3. **Build Status**: Confirm ecosystem dependencies (`pnpm install`) and core artifacts (`dist/`) are present.
4. **Environment Scanning**: Scan the environment and report any deficiencies immediately.

## Constraints
- **Identity Primacy**: Do not proceed if `my-identity.json` is missing; guide the user to `docs/INITIALIZATION.md`.
- **Infrastructure First**: Never attempt standardization until the package manager and build pipeline are stable.

## Physical Enforcement
Before any mission or significant task, the agent MUST run the prerequisite scan.

- **Automated Check**: `npx tsx scripts/mission_controller.ts start <ID>` (includes prerequisite scan).
- **Validation**:
  - Verification of `@agent/core` availability.
  - Confirmation of 3-Tier isolation via `tier-guard.js`.

---
*Status: Mandated by GEMINI.md*
