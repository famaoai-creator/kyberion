---
incident: DeepSeek harness plugin boundary failures
impact: A plugin loader can appear healthy while dropping exported metadata or disabling an entire feature family.
trace_or_example: DeepSeek harness postmortems 0001 and 0002, recorded in DSH_ADOPTION_PLAN_2026-08-17.ja.md.
root_cause: Framework loader semantics and truthy configuration expressions were not covered by product-visible integration assertions.
prevention: Require boot-composition tests, explicit provenance, fail-closed config parsing, and a rejected/design ledger entry for non-adopted alternatives.
---

The adoption work treats these failures as boundary defects rather than isolated plugin bugs. New
seams need a declaration, provider, consumer, reversible disposer, and an integration test through
the real boot path.
