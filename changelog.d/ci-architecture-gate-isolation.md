---
category: Fixed
---

- Run module-boundary and capability-seam AST checks exclusively through the existing check scheduler to reduce resource contention. All gate commands, baselines, selections and 120-second deadlines remain unchanged; ordinary gates retain the six-worker default.
