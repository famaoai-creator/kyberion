---
category: Changed
---

- Operator shell (Concierge `/` and `/ops`) reads at a glance:
  - Decision cards state what is asked, why, the impact of approving, rejecting or not answering, the recommendation and the deadline. Request ids, raw reasons and PR previews sit behind a details disclosure.
  - Machine text (JSON, hashes, repository paths, ids) is stripped from summaries.
  - Work items are a kanban board again, with keyboard moves and a confirmation step.
  - Organization key results show progress bars, targets and trend.
  - Intervention points give a plain-language reason and a next action, and the command is folded behind "show command".
  - Decision reasons render in the reader's language.
  - The Chronos redirect keeps the loopback host name.
- Fixed: the `/ops` customer-decision overview, case and learning views always failed with "could not read customer decisions". They now run a read-only `customer_decision_overview` entry under a dedicated `customer_decision_reader` role. Concierge itself still never holds `decision_ledger`.
