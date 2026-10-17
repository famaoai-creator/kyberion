---
category: Fixed
---

- **Actuator playground try-outs validate and gate correctly** — `--params` is optional for zero-argument ops, ops on flat contract schemas (build, pipeline envelopes) send their fields top-level, and contract validation accepts whichever discriminator key (`action` or `op`) each schema declares, so vcs/scheduler/calendar/data/working-memory/media-generation/wisdom/deployment/build ops no longer fail strict `additionalProperties` checks before execution.
- **`--dry-run` gates on the declared op kind** — the playground resolves capture/apply/transform/control from the discovery registry instead of a hardcoded name list, so read-only ops actually run under `--dry-run` and mutating ones stay skipped.
- **Terminal actuator rejects repo-root cwd clearly** — `spawn` with a cwd resolving to the repository root now explains that a subdirectory (e.g. `active/shared/tmp/<job>`) is required instead of a cryptic scope error, and one-shot actuator CLIs exit instead of lingering on spawned PTY handles.
- **Passkey cleanup no longer throws on blank pages** — WebAuthn session clearing skips WebStorage access on non-http(s) documents where it would raise SecurityError.
