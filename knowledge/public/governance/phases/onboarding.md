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
- **Action**: `pnpm onboard` (interactive) or `pnpm onboard:apply --identity path/to/identity.json` (non-interactive).
- **Effect**:
  - Build artifacts (`dist/`) are generated.
  - `presence` (external interface) services are initialized.
  - Personal Tier (`knowledge/personal/`) is physically secured.

### Stage 3: Soul Infusion (アイデンティティとビジョンの注入)
Inject the Sovereign's unique "Soul" into the established vessel.

#### Path A: Interactive Terminal (対話型ターミナル)
- **Action**: `node dist/scripts/onboarding_wizard.js`
- **Effect**: Wizard guides the Sovereign through identity, service readiness, tenant scope, and a safe first tutorial.

#### Path B: Non-Interactive / Agent Environment (非対話環境)
When running within a CLI agent (e.g., Claude Code) where stdin is unavailable, the wizard refuses to run by design — it would otherwise apply silent defaults. Pick one of:

1. **Sanctioned CLI**: `pnpm onboard:apply --identity path/to/identity.json` (or pipe JSON via stdin) — runs the same artifact-writing flow as `pnpm onboard` without prompts.
2. **Agent conversation + direct write**:
   - Agent reads `scripts/onboarding_wizard.ts` to understand the required schema.
   - Agent conducts the hearing conversationally with the Sovereign.
   - Agent writes output files directly, conforming to `knowledge/public/templates/my-identity.schema.json` and `knowledge/public/schemas/onboarding-state.schema.json`.
3. **Defaults bypass** (evaluation only): `KYBERION_ONBOARDING_NON_INTERACTIVE_OK=1 pnpm onboard` — accepts every default. Use only when defaults are knowingly acceptable.

- **Output**:
  - `knowledge/personal/my-identity.json`: Defines values, domain, and role.
  - `knowledge/personal/my-vision.md`: Defines the "North Star" (Vision).
  - `knowledge/personal/agent-identity.json`: Defines the Agent ID and trust tier.
  - `knowledge/personal/onboarding/onboarding-state.json`: Persists the phased onboarding state.
  - `knowledge/personal/onboarding/onboarding-summary.md`: Summarizes the captured setup.
  - `knowledge/personal/connections/*.json`: Stores approved service connection drafts.
  - `knowledge/personal/tenants/*.json`: Stores tenant profiles entered during onboarding.
  - `knowledge/personal/onboarding/tutorial-plan.md`: Records the first tutorial plan.
- **Effect**: The ecosystem aligns its autonomy with the Sovereign's personality.

## Success Metrics [L3]
1. **Physical Integrity**: `pnpm install` completed with no resolution errors.
2. **Operational Status**: `pnpm onboard:apply` returns `status: "complete"` after persisting the onboarding state.
3. **Identity Alignment**: `my-identity.json`, `my-vision.md`, and `agent-identity.json` all exist in the Personal Tier.
4. **Onboarding Summary**: `onboarding/onboarding-state.json` and `onboarding/onboarding-summary.md` are persisted.

## Related Documents
- **This file** (`governance/phases/onboarding.md`): Technical execution steps (Stage 1-3). **Primary reference from AGENTS.md.**
- `governance/onboarding-protocol.md`: Sovereign Concierge の行動規範と5段階の体験設計 (UX-level protocol).
- `orchestration/onboarding-directives/00_sovereign_onboarding.md`: 初回オンボーディングミッションの勝利条件と推奨アクション (Mission directive).

---
*Status: Mandated by AGENTS.md (Consolidated with docs/INITIALIZATION.md)*
*Last Updated: 2026-03-13 by KYBERION-PRIME*
