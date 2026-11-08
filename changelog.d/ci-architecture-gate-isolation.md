---
category: Fixed
---

- Run module-boundary and capability-seam AST checks exclusively through the existing check scheduler to reduce resource contention. All gate commands, baselines, selections and 120-second deadlines remain unchanged; ordinary gates retain the six-worker default.
- Apply the same isolation to catalog integrity checks after a concurrent full-run timeout. Catalog, vocabulary and knowledge-index coverage, path selection and the 120-second deadline remain unchanged; the precise timeout cause remains unattributed.
