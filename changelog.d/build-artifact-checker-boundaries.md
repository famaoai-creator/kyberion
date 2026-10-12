---
category: Fixed
---

- **Build-artifact freshness checks** now respect source-directory boundaries, pair stale source/output paths with their own timestamps, and preserve on-disk casing for missing emits. Windows CI runs the mixed-case and slash-format regression fixtures.
