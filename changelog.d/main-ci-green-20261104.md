---
category: Fixed
---

- Register `@agent/kernel` in `scripts/build-output-layout.ts` (clean, stale-dist, source-shadow and dist-import checks now cover `libs/kernel/dist`) and gate that every owned package dist is uploaded in the CI build artifacts; move the governance-import and platform-read baseline generators from raw `node:fs` to secure-io, so they no longer need a raw-fs exemption in the security-boundary contract.
