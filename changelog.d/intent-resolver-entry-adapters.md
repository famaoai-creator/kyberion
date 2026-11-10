---
category: Changed
---

- Surfaces now read a request once through the intent resolver entry. The shared surface conversation (Slack, voice, terminal) resolves the utterance once and carries the resulting `RoutingDecision` into intent compilation; the fallback execution brief uses its intent instead of re-reading project requests. The Slack, presence and long-message routing rules moved from the surface router into the resolver as input facts. The front desk reads the work-scope verdict for its configured receipt pipeline from the resolver.
- Discussion work items now take their work shape (incident response, governance cadence, routine operation, and so on) from the agreed proposal text. A proposal the resolver is unsure about (confidence below 0.7) keeps `solution_project` as before.
- Removed the keyword fallback that matched `compileIntent` against a caller-supplied intent catalog (no production caller used it; intents are selected by the resolver) and the unused `knowledge/product/classifiers/intent-rules.yml`.
