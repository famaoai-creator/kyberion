---
category: Fixed
---

- **Document/deck/video missions no longer deadlock at evaluation** — the `artifact_evaluation` tasks in `document-authoring`, `presentation-deck-production`, and `video-production` are now proper review tasks (independent reviewer, blocking findings), so `finish` is reachable. The evaluation now also scores readability and visual design (plus design-system conformity for documents).
- **Code review covers operability and extensibility** — the `code-change-aidlc` self-review and the `code-review-cycle` topic now name five lenses (correctness, security, regression, operability, extensibility).
