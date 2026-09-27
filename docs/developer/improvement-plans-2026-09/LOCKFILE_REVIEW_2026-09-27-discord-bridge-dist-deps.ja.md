---
title: discord-bridge dist dependency fix lockfile review 2026-09-27
tags: [release-governance, lockfile, discord-bridge, 2026-09]
last_updated: 2026-09-27
status: active
---

# discord-bridge dist dependency fix lockfile review (2026-09-27)

This record covers the single dependency addition made while fixing
`node dist/satellites/discord-bridge/src/index.js`'s
`ERR_MODULE_NOT_FOUND: discord.js`.

- **Before**: root `package.json` did not declare `discord.js`; it was only
  declared in `satellites/discord-bridge/package.json` (`^14.27.0`), so pnpm
  never hoisted it into the root `node_modules` the flat `dist/` tree
  resolves bare specifiers from at runtime.
- **After**: added `"discord.js": "^14.27.0"` to root `package.json`
  `dependencies` (same range already declared and already resolved in
  `pnpm-lock.yaml` via the satellite's own dependency — no new package
  version entered the lockfile, only a new hoist target) and ran
  `pnpm install --offline` to refresh `pnpm-lock.yaml`'s importer graph.
- **Method**: `pnpm install --offline` (package already present in the local
  store from the satellite's existing dependency); verified
  `CI=true pnpm install --frozen-lockfile` still passes; verified
  `pnpm check -- --scope pr --only pinned-deps` still passes (no override,
  lockfileVersion, or minimum-release-age changes).
- **Other changes**: none — no other dependency version changed.
- pnpm-lock.yaml sha256: 873be963736be9dc56ef4fc979c00db551d387e07686fb18692fb23f7cd2e711
- The accepted invocation is `PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-09/LOCKFILE_REVIEW_2026-09-27-discord-bridge-dist-deps.ja.md pnpm check -- --scope pr`.
