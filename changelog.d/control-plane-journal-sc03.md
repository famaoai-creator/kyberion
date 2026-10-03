---
category: Added
---

- **Control-plane journal persistence (SC-03)** — the Cloudflare OS control plane now writes tenant-namespaced append-only JSONL journals under `active/shared/runtime/<tier>/<tenant|shared>/cloudflare-os/` with locked appends and tail catch-up, so multiple processes can no longer lose each other's mutations. Snapshot files are rebuildable caches; observations roll up by mission × resource_ref × tier; legacy flat `control-plane.json` migrates once into the journals, with unresolvable-tenant records quarantined and audited instead of dropped.
