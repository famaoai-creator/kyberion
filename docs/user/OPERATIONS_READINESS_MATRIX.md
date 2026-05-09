# Operations Readiness Matrix

This is the user-facing view of what Kyberion can do reliably today.
It separates the core flows that are ready from the parts that still depend on
your local environment, credentials, or host permissions.

## Short answer

- You can use Kyberion for onboarding, customer overlays, mission work, and
  governance checks today.
- You can also use external channels such as Slack, iMessage, Discord, and
  Telegram, but those depend on local setup and account access.
- Reasoning backends work, but they still depend on CLI authentication, API
  keys, and provider quota.

## Matrix

| Area | Status | What that means |
|---|---|---|
| Customer overlays | Ready | Create, inspect, switch, and migrate customer workspaces. |
| Toolchain preflight | Ready | Run `pnpm prereq:check` before you build from source. |
| Onboarding | Ready | Run `pnpm onboard` to prepare the active workspace. |
| Health checks | Ready | Run `pnpm doctor` to see what is missing before you start. |
| Consolidated readiness | Ready | Run `pnpm setup:report` for surfaces, services, reasoning, and doctor together. |
| Mission lifecycle | Ready | Core mission flows are in place and usable. |
| Governance checks | Ready | Validation and policy checks are part of normal operation. |
| Surface lifecycle | Ready | You can enable, disable, and inspect individual gateways. |
| Slack / iMessage / Discord / Telegram / Google Workspace | Conditional | They work when the host app, permissions, and credentials are present. |
| Voice features | Conditional | They work when the device, engine, and profile are configured. |
| Browser / desktop automation | Conditional | These need the right permissions and a supported host setup. |
| Reasoning backends | Ready with guardrails | Claude, Gemini, and Codex paths work when the provider is authenticated and not rate-limited. |
| UI / web app | Conditional | Usable, but still has environment-specific warnings in the build path. |

## How to use this

1. Run `pnpm pipeline --input pipelines/baseline-check.json`.
2. Run `pnpm prereq:check`.
3. Run `pnpm setup:report`.
4. Run `pnpm doctor`.
5. Run `pnpm customer:list` if you use customer overlays.
6. Activate the customer you want with `pnpm customer:switch <slug>`.
7. Then work normally.

If a feature is marked conditional, check the host permissions or provider
authentication before assuming it will work.

## What is safe to rely on

- Customer overlays for keeping engagements isolated.
- Onboarding and doctor for readiness checks.
- Mission and pipeline execution for governed work.
- Registry management for surfaces and reasoning backends.

## What still needs environment checks

- iMessage, Telegram, Discord, and Google Workspace integrations.
- Voice engines and voice profiles.
- Browser automation.
- Provider quotas and API credentials.

This matrix is not saying the conditional features are broken.
It is saying they are ready only when the environment is ready.
