---
category: Fixed
---

- **Windows UI build spawn** — repository builds again resolve the pnpm lifecycle entrypoint (`npm_execpath`) on Windows: a native `pnpm.exe` (standalone installs) spawns directly, while a JS entrypoint such as `pnpm.cjs` (npm-installed pnpm, including `pnpm/action-setup` CI runners) runs through Node. A bare `pnpm.exe` PATH lookup is never attempted, so shim-only installs no longer fail with `ui failed to spawn`.
