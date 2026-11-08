---
category: Changed
---

- **Catalog actuator dispatch returns op payloads, not run envelopes** —
  `defineCatalogBackedActuator` normalizes one-step sub-pipeline reports into a
  channel value (`export_as` / `last_capture` / `last_transform`) or a branded
  context patch for ad-hoc keys. The pipeline engine maps those shapes only and
  fail-closes if a run envelope leaks through, so PTC `callOp`,
  `system:json_query`, `vcs:log`, and `file:exists` share one rule. Input-side
  `actionInput` (#860) is unchanged.
