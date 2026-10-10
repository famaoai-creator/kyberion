---
category: Security
---

- **secure-io decides the `node_modules` hard-link exemption on the canonical path** — root `node_modules/` holds pnpm workspace links back into writable trees (`node_modules/@actuator/service -> libs/actuators/service-actuator`), so a hard link to a higher-tier file planted there could be read through the alias. The exemption now requires the canonical path to lie under `node_modules/` at a location the caller cannot write.
- **Hard-link checks cover metadata and lock tombs more tightly** — `safeStat` and `safeFileAgeMs` refuse a foreign hard link like `validateFileSize` does. The lock-recovery exception is probe-only: only a `<base>.stale-*` tomb linked to its `<base>` in `active/shared/runtime/locks/` qualifies, and such a tomb may move only within its locks directory. A snapshot of a file that did not exist at check time must be single-link when opened. Missing parent directories are created against the canonical location the permission check judged.
