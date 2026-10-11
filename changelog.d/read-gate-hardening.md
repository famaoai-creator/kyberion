---
category: Security
---

- **Shared bound-partition scan contract for mission tier roots** — `missionTierScanDirs` (owner-scope) returns `<root>/<bound>` for a tenant-bound process on protected tier roots and the whole root otherwise, so mission enumerators (state scans, await-state sweep, run-journal discovery, hygiene) share one visibility rule instead of a try-readdir/probe-bound fallback per site.
- **`check_stale_dist` gains `emit_missing`** — a buildinfo-tracked source whose emitted `.js` is absent (partial dist wipe / stale incremental emit) is now flagged, closing the gap where a successful build could still leave `node dist/scripts/<x>` broken.
