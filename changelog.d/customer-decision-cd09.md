---
category: Added
---

- **Customer decisions during construction (CD-09)** — a mission task now records the customer decisions in force when it starts and checks them when it finishes. If the customer changed one meanwhile, the task still completes and one rework WorkItem is filed; a customer answer or operator `confirm` also finds tasks that already finished. Workers may return `customer_decisions` questions; the operator gathers them into a draft agenda with `pnpm kyberion customer-decision draft --from-tasks`, and work proceeds on our proposal. Money, contract, release and change-request questions hold the task (`awaiting_customer_decision`) until the operator confirms the customer's decision. Missions without a decision case are unchanged.
