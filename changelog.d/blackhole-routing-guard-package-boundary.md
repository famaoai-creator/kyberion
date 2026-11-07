---
category: Removed
---

- Removed the `@agent/core/blackhole-routing-guard` subpath: the in-process BlackHole mic-route registry is shared state between the two pipeline-execution parts that use it, so it now lives in `scripts/lib/blackhole-routing-guard.ts` next to its only consumers.
