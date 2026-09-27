---
category: Changed
---

- **Generated files no longer conflict between parallel PRs** —
  `knowledge/_integrity-manifest.json` is no longer committed (`pnpm build`
  rebuilds it); changelog entries are `changelog.d/` fragments folded in at
  release time by `pnpm kyberion changelog assemble`; and after merging or
  rebasing, `pnpm kyberion resolve generated` repairs conflicted generated
  files from the merge's conflict stages, regenerates them and stages them.
  The repository owner can optionally install a repo-local
  `kyberion-regenerate` merge driver once with
  `pnpm kyberion resolve install-driver` so `git merge` does not stop on these
  files; `pnpm install` never writes git config.
