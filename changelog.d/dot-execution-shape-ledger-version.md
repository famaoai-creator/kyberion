---
category: Changed
---

- Dot action proposals now name their shape `execution_shape` (the `dot_propose_action` tool schema, the fenced-reply instructions and the bounds prompt). A model reply that still says `work_shape` is read as an alias for one release; a proposal that carries both with different values is refused.
- The dot action ledger is versioned. New rows are written as `schema_version: 2` with `execution_shape` on the row and on its admitted proposal. Older rows (no `schema_version`, `work_shape`) are read unchanged: their hashes, recovery receipts and admission bindings are checked against the record exactly as it was written, and a status change of an old admitted action is written in the old version so the row and its admitted proposal still match.
- Dot WorkItems now carry `requested_execution_shape`. Items created from older actions keep `requested_work_shape`; the dot executor, mission admission, the front desk, continuous-operations reporting, the daemon watchdog and the concierge's mission-alignment action read both keys for one release. Ops-health and knowledge-hygiene findings are filed with the new key.
- A dot's execution shape is now checked through the shared `RoutingDecision`: dispatch and the executor build the decision for the dot's charter-bounded shape (dots never read utterances) and refuse work that the work-scope policy would route to a different shape. Under the current policy every dot shape keeps its shape, so nothing changes in practice.
- `pnpm kyberion dot intake --json` rows report the allowed shapes as `execution_shapes` (was `work_shapes`).
