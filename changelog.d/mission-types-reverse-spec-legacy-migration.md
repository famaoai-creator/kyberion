---
category: Added
---

- **`reverse_spec` mission type** — extracts traceable specifications from existing code through the `reverse-spec-extraction` workflow (scope → code-graph denominator → analysis → specify → independent audit). `check_reverse_spec_evidence` gates require a pinned baseline, two-route reconciliation, full denominator coverage, resolving `path:line` citations, UNKNOWN classes instead of guesses, a verifier distinct from the author and an unchanged source fingerprint.
- **`legacy_migration` mission type** — rebuilds a legacy system from an audited `rebuild`-purpose spec through the `legacy-migration-rebuild` workflow (brief → paradigm/disposition/strategy → parity pin → rebuild → equivalence), enforced by `check_legacy_migration_evidence`.
- **Mission-type promotion is table-driven** — `mission-type-promotion.ts` replaces the refactoring-only router; utterance markers stay in the classification policy, and spec extraction takes precedence over migration.
