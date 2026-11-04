---
category: Added
---

- Add a `runtime-readiness-check` seam (`libs/core/runtime-readiness.ts`) and a data-free `/api/readyz` probe on the Kyberion server: 200 when every registered check passes (builtin: runtime storage floor, governed seam policy, VCS backend resolution), 503 otherwise, with ids and booleans only on the wire. Subsystems that add a hard dependency register their own check; throwing or slow checks count as not ready. `/api/healthz` stays the liveness probe.
