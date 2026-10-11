---
category: Changed
---

- **CI: shared build artifact** — `ci.yml` and `pr-validation.yml` now run one `build-artifacts` job that uploads the owned compiler outputs (declared in `scripts/build-output-layout.ts`); downstream jobs restore them with `actions/download-artifact` instead of re-running `pnpm run build` (~4min per job). `first-win-clean-clone` keeps its own build, and `.next` UI bundles stay out of the artifact.
