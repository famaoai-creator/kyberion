---
category: Added
---

- **`pnpm check -- --changed` and `pnpm kyberion pr preflight`** — `--changed` (optionally `--base <ref>`, default `origin/main` then `main`) runs every `pr` gate plus each full-only gate whose new `paths` globs in `ci-gates.json` match a file changed since the merge-base (committed, uncommitted or untracked), and prints which extra gates it selected and why. `pnpm kyberion pr create` now runs this instead of `--scope pr`, and `pnpm kyberion pr preflight` runs the same readiness checks (title, `check --changed`, and the Knowledge check with `--body-file`) without creating a PR. A new `registration-tests` pr gate runs the `tests/` registration and boundary ratchets locally.
