---
category: Changed
---

- The intent gateway (`pnpm intent:run`) now resolves a request once and carries a `RoutingDecision` (intent, Execution Shape, authority level, delivery mode, promotion verdict) downstream, so execution no longer re-resolves the utterance. Whether an execution shape is mission scope on its own is now named only in `work-scope-policy.json`; the agent routing decision, the delivery decision and the `intent-policy.json` `durable-shapes` rule read that verdict. Routing outcomes are unchanged.
