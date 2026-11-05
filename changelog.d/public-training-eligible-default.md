---
category: Changed
---

- **Public material may be used for training.** A public reasoning scope, OCR request or knowledge context that declares no `training_use` now defaults to `training_eligible` instead of `local_only`, so public work reaches external backends without an explicit declaration. An explicit `local_only` is still honoured, and confidential and personal defaults are unchanged.
