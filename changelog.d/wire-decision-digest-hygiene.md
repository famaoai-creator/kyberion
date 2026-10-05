---
category: Added
---

- **Scheduled decision digest and approval hygiene** — `pipelines/decision-digest.json` sends the operator's "what needs me?" digest at 08:50 and 18:50 JST, and `pipelines/approval-store-hygiene.json` expires stale pending approvals daily. Both ship enabled; the digest goes out through the existing `decision_digest` route. Moving test-fixture approvals to the trash still needs `KYBERION_PERSONA=sovereign` and stays manual.
