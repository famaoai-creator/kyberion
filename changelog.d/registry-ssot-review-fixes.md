---
category: Fixed
---

- **ACP manifest tool policy matches the tool name only** — manifest-derived actuator stems are matched against the ACP `toolCall.kind` or the title's leading tool-name token, never free-text arguments, so `cat libs/core/agent/x.ts` is no longer denied as `agent-actuator` and `read system config` / `git status libs/core/process` stay allowed under worker deny lists. Legacy keyword mappings and fail-closed handling of unknown tools under restrictions are unchanged.
- **ACP risky-tool approvals receive the mediator's `hasHuman` / `hasUI` / `nonInteractive`** — the permission handler no longer reads `this.options` from inside the client object literal (which threw and cancelled every approval request).
- **Surface enable/disable no longer rewrites the committed registry** — `pnpm surfaces enable|disable` stores operator state in the untracked overlay `active/shared/runtime/surfaces/overrides.json`, merged when the canonical registry is loaded; `knowledge/product/governance/surfaces/*.json` stays the default. `pnpm surfaces reconcile` reports disabled surfaces as `skipped_disabled` with the enable command and warns when a gateway with configured credentials is now disabled by default.
- **Meeting selector constants load lazily** — the deprecated `MEET_SELECTORS` / `*_IN_MEETING_SELECTORS` exports no longer load the meeting platform registry at module import.
- **Reasoning provider descriptors must declare consistent egress** — `data_egress: local-only` with a public endpoint and `external-api` with a loopback/private endpoint are rejected at load time; `KYBERION_REASONING_PROVIDER_REGISTRY_DIR` / `_PATH` overrides are ignored (with a warning) when `NODE_ENV=production`.
- **Reasoning route doctor no longer calls the Anthropic API on every run** — `pnpm reasoning:config doctor` and the operator-surface reasoning page check key presence by default; pass `--live` for live credential probes.
