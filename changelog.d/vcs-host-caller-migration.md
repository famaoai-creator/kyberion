---
category: Changed
---

- PR checks, PR lists and default-branch reads in the vcs-actuator (`pr_list`, `pr_checks` including `watch`, `repo_view`), the standard PR lifecycle's auto-merge, and the mission-development PR lookup now go through the `vcs-host` seam, so they work on runtimes without the `gh` binary when `GH_TOKEN` is registered (`github-rest`). Output shapes are unchanged; `gh` invocations now pass `--repo` explicitly. Adds `vcsHostPrChecksWait` and an injectable `hostProvider` option.
