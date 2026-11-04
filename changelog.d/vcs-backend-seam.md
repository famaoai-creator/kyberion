---
category: Added
---

- Add a governed `vcs-backend` provider seam beneath the shared typed-verb git surface (`libs/core/vcs/git.ts`): every verb's default `run` now resolves through `resolveVcsBackend()` — explicit `run` injection still wins for tests, governed `default_chains` picks `local-git` (delegates to `safeExecResult`, byte-identical behaviour), and a `memory` recording/fixture backend enables hermetic verb tests. Remote backends (libgit2, VCS-host APIs) can register without touching call sites; `assertVcsCwdScope`, the local-verb allowlist and `governVcsCommand` stay above the backend so governance is uniform.
