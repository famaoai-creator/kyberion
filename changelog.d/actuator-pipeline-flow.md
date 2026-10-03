---
category: Fixed
---

- **Actuator playground accepts fine-grained ops** — `pnpm playground --actuator <id> --op <op>` now accepts discovery step ops (e.g. `file:read`), not just manifest entries. Single ops on pipeline-accepting actuators run wrapped in a one-step pipeline, the same shape production ADF uses.
- **`pnpm pipeline:promote` works again** — every promotion failed because the stamped `promotion` provenance key was rejected by the pipeline ADF schema. The schema and contract now allow it.
- **Peer accept points at the next step** — `peer collaboration accept` prints follow-up commands (`work create-item`, `pipeline:promote`) since acceptance alone never executes anything.
