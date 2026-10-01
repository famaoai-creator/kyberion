---
category: Added
---

- **Team channel thread linkage and channel memory (Team Channel P2)**:
  - **Mission linkage**: missions confirmed in a `team` channel carry the thread they came from, who confirmed them (`user:<member_id>`) and the channel's tenant scope. Progress and completion replies go back to that thread through the tenant's outbox.
  - **Status questions**: asking "status?" / 「状況は？」 in the thread lists the missions it started. The answer is read from mission state without going through the model.
  - **Channel memory**: facts are saved only on request, with `覚えて: …` / `remember: …` (operator or higher). They are removed with `忘れて <id>` (approvers) and listed with `メモ一覧` / `memory`. Memory is stored per tenant and channel, capped at the channel's disclosure tier, and passed into team turns as reference data only.
