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

#### Path A: Interactive Terminal (対話型ターミナル)
- **Action**: `npx tsx scripts/onboarding_wizard.ts`
- **Effect**: Wizard guides the Sovereign through identity and agent naming.

#### Path B: Non-Interactive / Agent Environment (非対話環境)
When running within a CLI agent (e.g., Claude Code) where stdin is unavailable:
1. Agent reads `scripts/onboarding_wizard.ts` to understand the required schema.
2. Agent conducts the hearing conversationally, asking the Sovereign the same questions.
3. Agent writes the output files directly, conforming to the schema in `knowledge/public/templates/my-identity.schema.json`.

- **Output**:
  - `knowledge/personal/my-identity.json`: Defines values, domain, and role.
  - `knowledge/personal/my-vision.md`: Defines the "North Star" (Vision).
  - `knowledge/personal/agent-identity.json`: Defines the Agent ID and trust tier.
- **Effect**: The ecosystem aligns its autonomy with the Sovereign's personality.

## Success Metrics [L3]
1. **Physical Integrity**: `pnpm install` completed with no resolution errors.
2. **Operational Status**: `scripts/run_orchestration_job.ts` returns `status: "finished"`.
3. **Identity Alignment**: `my-identity.json`, `my-vision.md`, and `agent-identity.json` all exist in the Personal Tier.

## Related Documents
- **This file** (`governance/phases/onboarding.md`): Technical execution steps (Stage 1-3). **Primary reference from AGENTS.md.**
- `governance/onboarding-protocol.md`: Sovereign Concierge の行動規範と5段階の体験設計 (UX-level protocol).
- `orchestration/onboarding-directives/00_sovereign_onboarding.md`: 初回オンボーディングミッションの勝利条件と推奨アクション (Mission directive).

---
*Status: Mandated by AGENTS.md (Consolidated with docs/INITIALIZATION.md)*
*Last Updated: 2026-03-13 by KYBERION-PRIME*
