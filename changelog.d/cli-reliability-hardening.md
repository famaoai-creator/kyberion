---
category: Fixed
---

- **Perception commands work under a persisted tenant scope** — `kyberion listen`, `see`, and `watch` no longer die with `ROLE_VIOLATION` when reading their own confidential/personal scratch files: guarded reads now run inside the new tenant-bound `perception_media_worker` role. Invalid media is rejected before ffmpeg, and backend failures are classified (`input_invalid`, `backend_missing`, `assets_missing`, `permission_denied`, `backend_runtime_error`) with the right next step instead of always suggesting `voice setup`.
- **Status commands no longer demand credentials they don't use** — `kyberion calendar status`, `email status`, `list --check`, and `mission verify/distill/finish` run without a claimed WorkItem credential binding; real connection verbs keep the deny-without-claim gate.
- **`dot status` and `intent trace` degrade honestly** — one corrupt or invisible record no longer kills the whole report; they now report `partial`/`integrity_error` with repair pointers.
- **`knowledge rank` accepts a positional query** as an alias for `--intent`.
- **Doctor's repo-build check judges content, not timestamps** — a fresh build is recognized by input fingerprints and a new `dist/.build-generation.json` receipt; `undefined:` anomaly labels and the false "newer source" flap are gone.
- **`kyberion read` error JSON is classified** (`not_found` in-scope, `out_of_scope` outside) with `code/category/next_action` fields on the stderr envelope.
