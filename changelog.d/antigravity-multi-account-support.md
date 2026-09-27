---
category: Added
---

- **Antigravity CLI (`agy`) multi-account profile support** — enables running multiple isolated Google accounts concurrently on a single host. Profiles reside under `~/.agy-profiles/<name>/` with isolated OAuth credentials and settings while transparently inheriting developer dotfiles. Controlled natively via `pnpm kyberion agy profile [list|add|delete|login|run|setup-host]` (with zero new `package.json` scripts) and `KYBERION_AGY_PROFILE`. Includes cross-shell wrapper generation (`agy`, `agy-use`, `agyp`) for `zsh`, `bash`, Windows batch (`.cmd`), and PowerShell, with Windows directory junctions preventing privilege escalation.
