---
category: Fixed
---

- Preserve the server's strict voice-selection request validation and guarded media-engine settings when integrating the core/shared package split. Both surfaces now consume the defining shared-voice modules, which explicitly declare their schema dependency; the engine-operator boundary check follows the moved module.
