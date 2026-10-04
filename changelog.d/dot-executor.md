---
category: Added
---

- **Dot executor and budget wiring** — resident dots now close the WorkItems they delegate: each supervisor sweep (`dot-executor` step) claims at most one ready item per active dot under a lease, snapshots its latest key-result values, and runs it by requested shape — an allowed pipeline (`authority.allowed_pipelines`), a bounded goal turn under the charter role (or a read-only delegated turn without a live tool backend); mission-shaped work is blocked with guidance and never started. Results land in the dot's `work-results.jsonl`, the audit chain and a report-back inbox wake, and the next wake prompt shows the last five. Dispatched WorkItems carry `pipeline_ref`, `expected_effect`, `target` and `intent`. The organization budget governor now raises proposals to approval at the soft threshold, pauses wakes and executor work at the hard limit, and appears in `dot status` and the digest.
