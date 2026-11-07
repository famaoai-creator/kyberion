---
category: Added
---

- `pnpm doctor` now shows a `VCS host:` line: which `vcs-host` provider forge operations would use, the provider order and where it comes from (builtin, policy or a saved default such as `KYBERION_SEAM_DEFAULTS`), and whether each candidate is usable (`gh` present, `GH_TOKEN` registered). This check stays offline. Pass `--vcs-auth` to also verify forge authentication for the selected provider; that is one network call with a 10-second limit. A host with no usable provider gets a fix hint but never counts as missing.
