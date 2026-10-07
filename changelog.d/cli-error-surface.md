---
category: Changed
---

- **CLI failures no longer dump stack traces** — every `pnpm`/kyberion script
  entrypoint now prints `error.message` plus a `next:` remediation hint instead
  of a raw stack. Stacks still appear when `DEBUG` is set, and `--json` error
  reports stay structured (`{ ok:false, error, next? }`).
- **Errors carry actionable diagnostics** — the main CLIs (`kyberion`, `cli`,
  `mission_controller`) now throw `DiagnosticError` (`[CODE] what — why |
next: remedy`), and common system errors (ENOENT, EACCES, ECONNREFUSED,
  missing dist/ modules, …) get an auto-derived `next:` hint at the failure
  boundary.
