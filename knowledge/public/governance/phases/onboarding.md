# Phase Protocol: ① Onboarding (Ecosystem Initialization)

## Goal
Environment safety verification and identity synchronization via physical manifestation.
This phase transforms the ecosystem from a "dormant state" to an "activated state" where the Sovereign's intent is physically manifest.

## Directives

### Stage 1: Physical Foundation (物理的基盤の確立)
Establish the neurological link between modules.
- **Action**: `pnpm install`
- **Effect**: All workspace dependencies and internal `@agent` links are realized.

### Stage 2: System Manifestation (システムの具現化)
Construct the physical structure and activate services based on governance.
- **Action**: `npx tsx scripts/run_orchestration_job.ts` (Running the "System Onboarding" job).
- **Effect**:
  - Build artifacts (`dist/`) are generated.
  - `presence` (external interface) services are initialized.
  - Personal Tier (`knowledge/personal/`) is physically secured.

### Stage 3: Soul Infusion (アイデンティティとビジョンの注入)
Inject the Sovereign's unique "Soul" into the established vessel.
- **Action**: Concierge hearing process and automated generation.
- **Output**:
  - `knowledge/personal/my-identity.json`: Defines values, domain, and role.
  - `knowledge/personal/my-vision.md`: Defines the "North Star" (Vision).
- **Effect**: The ecosystem aligns its autonomy with the Sovereign's personality.

## Success Metrics [L3]
1. **Physical Integrity**: `pnpm install` completed with no resolution errors.
2. **Operational Status**: `scripts/run_orchestration_job.ts` returns `status: "finished"`.
3. **Identity Alignment**: Both `my-identity.json` and `my-vision.md` exist in the Personal Tier.

---
*Status: Mandated by AGENTS.md (Consolidated with docs/INITIALIZATION.md)*
*Last Updated: 2026-03-10 by Ecosystem Architect*
