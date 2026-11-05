---
category: Changed
---

- The remaining forge callers now run through the `vcs-host` seam, so PR publication, merge promotion and development CI proof work without the `gh` binary when `GH_TOKEN` is registered (`github-rest`): vcs-actuator `pr_view`, the PR shadow observer, `development-proof` / `development-loop`, the publication and worktree-governance hosts, and `pnpm kyberion pr create` (whose credential preflight is now provider-agnostic). `pr_view` `fields` are limited to the gh names listed in `VCS_PR_FIELDS`. Adds `vcsHostPrViewFields` and the allowlisted `vcsHostGithubApiGet`. `runVcsMutationWithApproval`, `runVcsMutationWithWorktreeGovernance`, `observePullRequests`, `reconcileVcsDevelopment`, `runPreparedVcsDevelopment` and the `readVcsDevelopment*` readers are now async.
