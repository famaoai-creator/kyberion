---
category: Fixed
---

- **`node dist/satellites/discord-bridge/src/index.js` no longer crashes with
  `ERR_MODULE_NOT_FOUND: discord.js`** — the compiled `dist/` tree is a flat,
  shared output with no per-package `node_modules`, so it resolves bare
  third-party specifiers only from the root `node_modules`; `discord.js` was
  declared only in `satellites/discord-bridge/package.json`, never at the
  root, so it never got hoisted there (same root cause class as PR #806's
  `@actuator/service` fix). Added `discord.js` to the root `package.json`
  dependencies and updated `pnpm-lock.yaml`. `scripts/check_dist_workspace_imports.ts`
  (PR gate `dist-workspace-imports`) is now generalized to also resolve every
  third-party bare specifier imported by `dist/{presence,satellites,scripts}`
  entry files that some package.json declares as a real (non-dev) dependency,
  with a documented (currently empty) allowlist for genuinely optional
  try/catch-guarded dynamic imports, so this class of bug can't recur silently.
