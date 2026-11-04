---
category: Added
---

- Add the async `vcs-host` provider seam for forge operations (pull requests, checks, repository metadata), separate from the git command-runner `vcs-backend` seam. Governed verbs in `libs/core/vcs/vcs-host-verbs.ts` (`vcsHostPrCreate`, `vcsHostPrMerge`, `vcsHostPrView`, `vcsHostPrList`, `vcsHostPrChecks`, …) build effects identical to the sync `github.ts` verbs, so approvals, delegation targets and protected effect paths are unchanged whichever provider runs. Builtins: `gh-cli` (default, same argv as today) and `github-rest` (GitHub REST/GraphQL via `secureFetch`, available when `GH_TOKEN`/`GITHUB_TOKEN` is registered, for runtimes without the `gh` binary); `memory` is a test-only forge. Selection follows `seam-provider-selection/vcs-host.json` and `KYBERION_SEAM_DEFAULTS`. Existing sync gh callers are unchanged.
