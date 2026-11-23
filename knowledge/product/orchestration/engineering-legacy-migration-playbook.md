---
title: 'Engineering Legacy Migration Playbook — rebuild from an audited spec and prove parity'
tags: [orchestration, engineering, legacy-migration, modernization, verification, playbook, agent]
last_updated: 2026-11-23
runtime_stages: [planning, contract_authoring, execution, verification, delivery]
workflow_ids: [legacy-migration-rebuild]
---

# Engineering Legacy Migration Playbook

Use mission type `legacy_migration` (class `code_change`; set it with `mission create --mission-type legacy_migration`) to rebuild a legacy system on a new
architecture or stack (the "Reimagine" approach). The `legacy-migration-rebuild` workflow binds
this playbook. Changing only the runtime, framework or libraries while keeping the code's
business logic is a refactoring (`refactoring` mission), not a migration.

A migration starts from specifications, not from the old code: the input is a
[`reverse_spec`](./engineering-reverse-spec-playbook.md) mission with purpose `rebuild` whose
audit passes. Rules missing from the spec disappear from the new system, and errors in the spec
are built into it, so the intake gate re-runs the source mission's audit before anything else.

Design sources: Reversa's migration team (sandeco/reversa, MIT) and the Reimagine flow around
Reverse Spec Flow (aws-samples/sample-reverse-spec-flow, MIT-0). Checker:
`scripts/check/check_legacy_migration_evidence.ts --stage <stage>`.

## Phases and evidence

| Phase                | Deliverable                         | Gate (checker stage)                                 |
| -------------------- | ----------------------------------- | ---------------------------------------------------- |
| `intake_scope`       | `evidence/migration-brief.json`     | `brief` (source spec audit re-run, snapshot current) |
| `planning`           | `evidence/migration-decisions.json` | `decisions` + human approval                         |
| `contract_authoring` | `evidence/parity-matrix.json`       | `pin`                                                |
| `execution`          | `evidence/migration-report.md`      | `implement`                                          |
| `test`               | `evidence/equivalence-report.json`  | `equivalence`                                        |

1. **Brief.** `source_spec_mission_id`, objective, success metrics, `target_stack` (at least the
   language) and scope (included / excluded). Paradigm and appetite are decided in the next
   phase, not asked up front. Freeze the source spec with `check_legacy_migration_evidence
--mission <id> --write-source-snapshot`: it refuses unless the source mission passes its
   audit, and writes `evidence/source-spec-snapshot.json` (spec ids and layers plus the sha256 of
   the source spec and verification ledgers). The brief gate fails if the snapshot is missing,
   stale or edited (it must equal a freshly built one); later stages read spec ids from the snapshot only, so re-opening or archiving the
   source mission cannot shift the migration contract.
2. **Decisions.** Record the legacy and target paradigms and the gap between them. Give every
   essence-layer spec a disposition: `migrate`, `discard` (with a reason — a dropped rule
   vanishes), or `human_decision` (open; the gate fails until a person decides). Choose a
   strategy — `strangler_fig`, `big_bang`, `parallel_run` or `branch_by_abstraction` — with at
   least one rejected alternative and a rationale. This gate is held for human approval.
3. **Parity pin.** For every migrated spec write at least one parity scenario (`gherkin`,
   `golden` or `characterization`) under the mission and record its result on the legacy system.
   Known legacy bugs are pinned as `fail_recorded` — fixing them is a decision, not an accident.
4. **Rebuild.** Implement on the target stack from the approved specs and dispositions only,
   tracing code to spec ids; do not fill gaps by guessing — return to the spec mission instead.
   The report names the specs, the scenarios and that they ran green.
5. **Equivalence.** Run every parity scenario on the target. Each result is `pass` or a
   `deviation` with a reason and `approved_by`. Unapproved deviations fail the gate.

Delivery runs the usual `docs-sync` task and is held for human approval.

## Related

- [engineering-reverse-spec-playbook](./engineering-reverse-spec-playbook.md) — produce the
  audited spec this mission consumes.
- [engineering-refactoring-playbook](./engineering-refactoring-playbook.md) — pinning
  techniques (characterization, golden files) shared with the parity phase.
