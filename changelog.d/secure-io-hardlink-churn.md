---
category: Security
---

- **Hard-link churn no longer beats the tier guard** — a loop of `rm name; ln knowledge/personal/…/secret name` in a writable directory could make `safeReadFile` return, and `safeAppendFileSync` write into, a personal-tier file. The opened descriptor is now re-checked after the location check (inode, link count, and a ctime a `utimes` mask cannot fake — only a size change counts as a data write), a deleted name is served only while the inode itself is fully unlinked (`nlink` 0 — the atomic write-then-rename replacement), and the name opened through must otherwise still be linked — read after settling the parent directory's lock — before the hard-link rule runs on the final `fstat`. Appends are vetted before any byte is written.
- **A symlinked checkout root lists off Linux** — the root identity pin follows `KYBERION_ROOT`, so `safeReaddir('.')` and repository walks work when the root is itself a link.
- **New-file appends work on Linux without `/proc`** — the create falls back to the by-path branch used elsewhere instead of failing with `ENOENT`.
- **Scope offboarding never verifies a refused listing as clean** — a denied or changed directory listing is reported as a leftover instead of an empty directory.
- **The agent runtime supervisor restores its umask even if `listen()` throws.**
