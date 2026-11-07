---
category: Changed
---

- The sync gh verbs in `libs/core/vcs/github.ts` (`ghRun`, `ghMust`, `ghPrView`, `ghPrList`, `ghPrChecks`, `ghPrChecksWait`, `ghPrMerge`, `ghPrCreate`, `ghPrQueued`, `ghRepoDefaultBranch`) are deprecated in favour of the async `vcs-host` verbs. A new PR gate, `vcs-host-boundary` (`scripts/check_vcs_host_boundary.ts`), rejects production code that execs the `gh` CLI outside the allowlisted provider and diagnostic files or that references a deprecated sync verb. `ghVersion` / `ghAuthStatus` (CLI diagnostics) and `ghRepositoryVisibility` (the sync push-path visibility probe) remain supported. `publication-host` now types its mutations from `VcsHostPrCreateParams` / `VcsHostPrMergeParams` and exports `PrPublicationParams`.
