---
category: Changed
---

- `KYBERION_PERSONA` is renamed `KYBERION_BASE_ROLE` (Concept Model v2 D5: the value names the base Authority Role the process runs on, e.g. `worker` → `base_worker`). The old name is still read for one release, with a warning, only when `KYBERION_BASE_ROLE` is not set; an empty `KYBERION_BASE_ROLE` means no base role and never falls back to the old name. Update `.env.local`, shell profiles, surface manifests and CI to `KYBERION_BASE_ROLE`. Surface manifests, plugins, pipelines and workflows shipped in the repository already use the new name.
