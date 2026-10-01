---
category: Changed
---

- **Surface manifest is the single surface registry (RS-04)** — ports, health paths, URL-override env names, operator notes (vocabulary keys, en + ja) and remediation commands now live in the surface manifest; `resolveSurfaceUrl` / `resolveSurfacePort` replace hardcoded `127.0.0.1:<port>` fallbacks in presence-bridge, a2ui, voice-hub, presence-studio, the presence actuator and the Telegram polling bridge, and `control-plane-client` / `surface-ux` read the registry instead of per-surface switches. `operator-surface`, `personal-pads` and `terminal-hud` are registered (`enabled:false`). `slack-bridge`, `telegram-bridge` and `imessage-bridge` now default to `enabled:false` so a fresh `pnpm surfaces reconcile` no longer starts credential-dependent or macOS-only gateways; enable with `pnpm surfaces enable --surface <id>` (`pnpm surfaces setup` prints it; `setup-messaging-bridge` does it).
