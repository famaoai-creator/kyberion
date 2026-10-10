---
category: Security
---

- **secure-io hard-link exemptions are pinned to the opened file** — the pnpm-store exemption now applies only while the re-derived canonical path still names the inode that was opened, so flipping a symlink between the open and the check can no longer leak a hard-linked file. A multi-link file outside the repository (a vault mount target) gets no exemption. The pnpm content store (`node_modules/.pnpm/`) is readable for every caller, SUDO included.
- **Lock release during recovery** — `releaseLock` and lock inspection read a record through its `.stale-*` tomb when the record itself is refused as a hard link, so a live owner's lock is no longer left behind during the put-back window.
- **Not-found errors carry `ENOENT`** — secure-io's `File not found` errors from `safeReadFile`, `safeReadFileRange` and `safeReadFileTail` now set `code: 'ENOENT'`, so callers that classify by code (lock inspection: missing vs unreadable) see a missing file as missing.
