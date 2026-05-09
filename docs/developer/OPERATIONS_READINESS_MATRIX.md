# Operations Readiness Matrix

Kyberion is usable today, but not every subsystem has the same maturity.
This matrix separates what is operationally ready from what is usable only
with environment prerequisites, and what still needs caution.

## Bottom line

- Core mission and governance flows are production-usable.
- Customer overlay flows are production-usable.
- Surface gateways are usable, but each one still depends on local OS or
  service credentials.
- Reasoning backends are usable, but their availability depends on CLI/API
  authentication and quota state.
- UI and host-specific integrations still carry known environment warnings.

## Matrix

| Area | Status | Why |
|---|---|---|
| Mission lifecycle | Ready | `create`, `resume`, `verify`, `distill`, and state persistence are in place and tested. |
| Customer overlay | Ready | `customer:create`, `customer:list`, `customer:switch`, and migration flows are wired end to end. |
| Onboarding / doctor | Ready | `pnpm onboard` and `pnpm doctor` give actionable readiness checks. |
| Consolidated readiness | Ready | `pnpm setup:report` shows surfaces, services, reasoning, and doctor in one pass. |
| Baseline / vital pipelines | Ready | `pnpm vital:json` and `pnpm pipeline --input pipelines/baseline-check.json` are used as real gates. |
| Governance / contracts | Ready | Registry splits, schema checks, and policy checks are enforced by tests and scripts. |
| Surface lifecycle management | Ready | Individual surface enable/disable/status flows work and are managed per gateway. |
| Reasoning backend selection | Ready with guardrails | `claude-cli`, `gemini-cli`, `codex-cli`, and `anthropic` are selectable, but availability depends on local auth and provider quota. |
| Gemini quota fallback | Ready with guardrails | Quota exhaustion falls through to the next candidate profile instead of stopping early. |
| Slack / iMessage / Discord / Telegram gateways | Conditional | They work when the local machine has the required permissions, tokens, and host integrations. |
| Voice workflows | Conditional | They depend on platform permissions, installed engines, and profile setup. |
| Browser / host automation | Conditional | They depend on browser access, OS permissions, and host-specific capabilities. |
| UI / Next.js surface | Conditional | The app builds and runs, but there are still known warnings in the UI build path. |
| Cross-platform parity | Risky | macOS-oriented flows are better covered than Windows/Linux equivalents. |

## Interpretation

Use this matrix as an execution guide:

- If a row is `Ready`, you can rely on it for normal work.
- If a row is `Ready with guardrails`, verify credentials or quota before
  assuming it will work in every environment.
- If a row is `Conditional`, do a capability check first.
- If a row is `Risky`, expect environment-specific failures and avoid treating
  it as a default path.

## Practical usage

Recommended default flows:

1. `pnpm pipeline --input pipelines/baseline-check.json`
2. `pnpm setup:report`
3. `pnpm run doctor`
4. `pnpm vital:json`
5. `pnpm onboard`
6. `pnpm customer:list`

When those pass, the workspace is usually good enough for normal operator work.

## What is still not fully flat

- External surface integrations are only as reliable as the host permissions and
  credentials behind them.
- Provider selection is deterministic enough for production use, but not
  environment-free.
- The UI layer is functional, but still carries warning-level build output.

This is not a claim that the system is finished.
It is a statement that the core control plane is already usable, while the
edges still need environment-specific validation.
