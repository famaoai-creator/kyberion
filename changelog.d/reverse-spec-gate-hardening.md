---
category: Changed
---

- The reverse_spec audit binds `author_actor_id` / `verifier_actor_id` to the actors that recorded the `*-specify` and `*-independent-verify` tasks in the mission execution ledger, and rejects an actor who recorded both.
- Random audit sampling is derived from the spec ledger hash (`sampling.seed`); every sampled claim must be verified. `check_reverse_spec_evidence --print-sample` prints the sample.
- Denominator dispositions must reference a JSON decision record (`reverse-spec-decision-record.schema.json`).
- legacy_migration freezes the source spec at the brief (`check_legacy_migration_evidence --write-source-snapshot` → `evidence/source-spec-snapshot.json`); later stages no longer read the live source mission.
- Code-graph parsers and compiled queries are released after each extraction instead of living for the process.
