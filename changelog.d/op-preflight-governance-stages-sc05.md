---
category: Added
---

- **Standard governance stages in the op waterfall (SC-05)** — `core:introduction` (order 112) and `core:taint` (order 115) now run for every op after `core:effect`, so introduction enforcement and taint projection are no longer service-actuator internals. Post-op, `recordOpObservation` aggregates `effect: read` ops into the control-plane observation journal from both execute choke points (actuator-sdk, adf-engine). Modes roll out per stage × op family via `op-preflight-rollout.json` (warn by default; `service` family stays off while its context-declared path remains authoritative).
