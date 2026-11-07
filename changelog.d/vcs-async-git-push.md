---
category: Changed
---

- `gitPush` (`@agent/core/vcs/git`) is now async. It checks the destination repository's visibility through the `vcs-host` seam (`vcsHostRepositoryVisibility`), so pushing to a private repository works without the `gh` binary when `GH_TOKEN` is registered. The push effect and its approval hash are unchanged. Onboarding's `buildDelegationInput` is async for the same reason. `ghRepositoryVisibility` is deprecated, and the `vcs-host-boundary` gate now rejects new references to it. `vcsHostOptionsForRunner` treats the default vcs-backend runner like no runner, so the seam's provider chain (gh-cli, then github-rest) applies.
