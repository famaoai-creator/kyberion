---
category: Fixed
---

- **Dot execution recovery** — timed-out pipeline work retains its declared target until effects are reconciled, preventing conflicting queued work and proposals. Already-running operations may finish; later pipeline steps are fenced. Use the existing authenticated human release after confirming execution stopped and checking partial effects.
- **Dot execution fairness** — budgeted executor sweeps persist their continuation across restarts so a continuously busy early dot does not starve later eligible dots. Existing per-dot limits still apply.
