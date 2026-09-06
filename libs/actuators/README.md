# Kyberion Actuators (The Physical Engines)

## 1. Overview

Actuators are the generic, high-fidelity execution engines of the Kyberion ecosystem. They serve as the physical interface between the agent's logic (Procedures) and reality (Filesystem, Network, OS, Blockchain).

The live catalog is **32 manifest-backed actuators**. Do not treat the historical "Core Nine" list as current.

## 2. Design Principles

- **Agnostic Logic**: Actuators only know _how_ to execute a specific class of physical actions based on ADF (Agentic Data Format).
- **Capability Manifest**: Each Actuator self-declares its canonical public operations, platforms, and binary requirements via `manifest.json`.
- **Canonical Contract First**: Compatibility handlers may remain in code during migration, but `manifest.json` should expose only the recommended public `op` surface.
- **High Fidelity**: Provides immutable evidence (hashes, signatures) for every action taken.

## 3. Catalog (redirect)

The operator catalog is generated from `libs/actuators/*/manifest.json`. **Do not maintain a second actuator list here.**

- Current table: [`CAPABILITIES_GUIDE.md`](../../CAPABILITIES_GUIDE.md)
- Discovery without `dist/`: `pnpm capabilities` or `pnpm kyberion list`
- Single-op dry-run: `pnpm playground -- --actuator <id> --op <op> --params '{…}' --dry-run --json`
- Runtime execution (`pnpm pipeline`, `pnpm kyberion run`) still needs `pnpm build`
- Actuator `--dry-run`: capture still runs; apply validates only
- Linux secrets: set `KYBERION_ALLOW_FILE_SECRETS=1` (file vault `chmod 0600`); darwin/win32 keychain unchanged

For Slack (conversation vs presence vs API) see [`docs/SLACK_CHANNEL_ROUTES.ja.md`](../../docs/SLACK_CHANNEL_ROUTES.ja.md).  
Presence satellite forward: `telegram:<id>` / `discord:<id>` / `imessage:<id>` on `presence:dispatch`.  
For email inbox vs send see [`docs/EMAIL_OPERATOR.ja.md`](../../docs/EMAIL_OPERATOR.ja.md).  
Cloud Agent Node/build: [`docs/developer/CLOUD_AGENT_ENVIRONMENT.md`](../../docs/developer/CLOUD_AGENT_ENVIRONMENT.md).  
Meeting: daily path is browser-playwright; `zoom-sdk` / `recall-ai` remain unimplemented seams.

## 4. Implementation Status & Capabilities

```bash
pnpm capabilities
```

`pnpm kyberion list` uses the same discovery path when `dist/` is missing.

## 5. Example Entry Points

Sample inputs for individual actuators live under each actuator's `examples/` directory.

- `libs/actuators/approval-actuator/examples/`
- `libs/actuators/artifact-actuator/examples/`
- `libs/actuators/browser-actuator/examples/`
- `libs/actuators/android-actuator/examples/`
- `libs/actuators/ios-actuator/examples/`
- `libs/actuators/media-actuator/examples/`
- `libs/actuators/media-generation-actuator/examples/`
- `libs/actuators/modeling-actuator/examples/`
- `libs/actuators/service-actuator/examples/` (includes `github-list-issues.json`)

---

_Last Updated: 2026-09-06_
