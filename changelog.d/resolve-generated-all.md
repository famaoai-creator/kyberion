---
category: Changed
---

- **One command regenerates every generated file** — `pnpm kyberion resolve generated` now also covers op-registry, pseudo-locale, vocabulary-types, pii-rules, the CLI reference, capability seams, subagent definitions and provider hooks (in dependency order), and `--check` lists every drifted file with the fix command. A new `.husky/pre-push` hook runs the `--check` before each push (skip once with `KYBERION_SKIP_PRE_PUSH=1 git push`), so generator drift no longer costs a CI round.
