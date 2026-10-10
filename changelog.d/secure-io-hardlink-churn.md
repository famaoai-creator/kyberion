---
category: Security
---

- **Hard-link churn no longer beats the tier guard** — a loop of `rm name; ln knowledge/personal/…/secret name` in a writable directory could make `safeReadFile` return, and `safeAppendFileSync` write into, a personal-tier file. Hard links are now judged only on a link count proven to include the name that was opened (Linux: the `/proc` entry is not deleted, after waiting out an unlink in progress; elsewhere: an exact fstat/lstat/fstat snapshot of link count and ctime). A file replaced by an atomic rename (no names left) is accepted at the name it had, and a concurrent chmod or utimes no longer refuses reads on Linux. Appends are vetted before any byte is written.
- **A symlinked checkout root lists off Linux** — the root identity pin follows `KYBERION_ROOT`, so `safeReaddir('.')` and repository walks work when the root is itself a link.
- **New-file appends work on Linux without `/proc`** — the create falls back to the by-path branch used elsewhere instead of failing with `ENOENT`.
- **Scope offboarding never verifies a refused listing as clean** — a denied or changed directory listing is reported as a leftover instead of an empty directory.
- **The agent runtime supervisor restores its umask even if `listen()` throws.**
