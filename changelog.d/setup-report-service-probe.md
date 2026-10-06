---
category: Fixed
---

- **`pnpm kyberion setup report` and `pnpm service:setup` no longer stall on the X API probe.** The `xapi` auth health check ran `npx -y @xdevplatform/xurl auth status`, which downloaded the package from npm on every report and blocked for 30 seconds or more (and could leave an orphaned `npm exec` process behind). It now checks only an already-installed `xurl` (`npx --offline --no …`), and every CLI auth health check is capped at 10 seconds. On a fresh machine the setup report drops from about 35–40 seconds to about 12.
- **`pnpm backup` reports a bad subcommand or flag as a usage error** (exit code 2, no stack trace). The usage text now shows `--out` as optional, matching the default archive path.
