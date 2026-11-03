---
category: Added
---

- **event-bus seam** — `libs/core/event/` adds the `EventBus` contract (topic publish/subscribe) on a named provider-registry seam. `local-process` is the governed default (same in-process implementation as `memory`, distinct id for selection-policy clarity); `createMemoryEventBus({ id })` gives hermetic isolated buses for tests. Selection order is governed data (`seam-provider-selection/event-bus.json`), so distributed PubSub providers can land later without shipping Redis now or touching call sites.
