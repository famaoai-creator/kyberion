---
category: Changed
---

- **Generated files no longer conflict between parallel PRs** —
  `knowledge/_integrity-manifest.json` is no longer committed (`pnpm build`
  rebuilds it); changelog entries are `changelog.d/` fragments folded in at
  release time by `pnpm kyberion changelog assemble`; and `pnpm install`
  registers a repo-local `kyberion-regenerate` merge driver for the generated
  files that stay tracked. After merging or rebasing, run
  `pnpm kyberion resolve generated` to regenerate and stage them.
