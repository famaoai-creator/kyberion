---
category: Added
---

- **Charter information-flow entry points and audit loop** — `approval:evaluate_decision_rights` now takes trusted `information_flow` facts (purpose, recipient class, categories, attachments) and the charter form can delegate an explicit recipient scope (`recipient_purposes`/`recipient_classes`/`recipient_categories`/`max_attachments`, plus the `known_counterparty` recipient class). Missing facts still hold an external action for a human; malformed facts are an input error rather than a silent "no facts". Budget read-check-append is now one inter-process critical section per charter scope, so concurrent decisions cannot double-spend the same remaining budget. The accountability report groups information-flow denials and proposes narrowing or stopping a delegated scope (advice only; the accountable human must re-accept), and a deterministic 5% sample of autonomous external actions is echoed to the operator for sampling audit.
