---
title: 'Engineering Reverse Spec Playbook — extract traceable specifications from existing code'
tags:
  [orchestration, engineering, reverse-spec, specification, verification, legacy, playbook, agent]
last_updated: 2026-11-23
runtime_stages: [planning, contract_authoring, execution, verification, delivery]
workflow_ids: [reverse-spec-extraction]
---

# Engineering Reverse Spec Playbook

Use mission type `reverse_spec` (class `code_change`) to turn an existing code base — one with
no specification, a stale one, or a black box — into specifications an AI agent can rely on.
The `reverse-spec-extraction` workflow binds this playbook. Its output feeds either maintenance
(answering "what does the system do today, and what breaks if I change X?") or a rebuild through
a [`legacy_migration`](./engineering-legacy-migration-playbook.md) mission.

Design sources: Reverse Spec Flow (aws-samples/sample-reverse-spec-flow, MIT-0) and Reversa
(sandeco/reversa, MIT). Their ideas are re-implemented as Kyberion gates; neither is vendored.

## Why a procedure, not a prompt

Asking an agent to "write the spec for this code" returns a plausible document with four
recurring defects: unsupported statements leak into downstream implementation; the agent covers
the main parts and reports "done" with nobody knowing what is missing; current-stack details
(framework, class layout, ORM) are written as if they were requirements; and screens, reports
and batch ordering are dropped. Verified and unverified statements also look the same, so the
consuming agent trusts both equally.

The workflow therefore does not trust agent output. Every gate is a typed checker
(`scripts/check/check_reverse_spec_evidence.ts --stage <stage>`); a stage is complete when its
checker exits 0, never when an agent says so.

## Phases and evidence

| Phase        | Deliverable                                     | Gate (checker stage)                           |
| ------------ | ----------------------------------------------- | ---------------------------------------------- |
| `ingest`     | `evidence/reverse-spec-scope.json`              | `scope` + human confirmation                   |
| `code_graph` | `evidence/code-graph.json`                      | `code_graph` + human freeze of the denominator |
| `analysis`   | `evidence/analysis-ledger.json`                 | `analysis` (every node covered)                |
| `specify`    | `evidence/spec-ledger.json`, `evidence/specs/*` | `specify` (citations resolve)                  |
| `audit`      | `evidence/verification-ledger.json`             | `audit` (independent, source intact)           |

1. **Ingest.** Copy or clone the target into `active/shared/staging/<job>/` and treat it as
   read-only. The source root may not contain the workspace `active/`, `knowledge/` or `vault/`
   trees (their writes would break the fingerprint and they hold higher-tier data). Record
   `source_root`, `baseline_commit` (or `baseline_note` when there is no VCS),
   `purpose`, `in_scope`, `exclusions` and every existing document in `references` with
   `status: unverified_claim`. Documents are claims with a known source until code confirms
   them; when a document contradicts the code, the code wins and the conflict is recorded.
2. **Code graph — the denominator.** Enumerate modules, entrypoints and external boundaries
   (nodes) and their dependencies (edges) by a mechanical full scan, never by targeted grep.
   Count each node kind by two independent routes and record both counts **and the element
   difference** (`only_in_a`, `only_in_b`): equal counts do not prove equal sets. Every
   difference needs a `resolution`. Paths left out of the graph (`excluded_paths`, for example build
   output or vendored code) must each be a scope exclusion with a reason; the fingerprint still
   covers the whole tree. Source files in a language no rule analyzes appear in
   `unanalyzed_extensions`; declare each extension in the scope's `uncovered_extensions` with a
   reason, or the gate fails. The gate recomputes the counts and differences from the nodes' routes,
   so the reconciliation cannot be edited apart from the graph. The file also records `source_fingerprint`. Freezing the
   graph is a held decision; changing the denominator afterwards needs a new decision.
3. **Analysis.** Read every node down to its implementation from the ARCH, REQ, API, DATA,
   BEHAVIOR and NFR viewpoints, and give each analysis item an id `ANA-<CAT>-<n>`. A node leaves
   the denominator only through a `dispositions` entry with a reason and a `decision_ref` file
   under the mission (for example `evidence/decisions/ADR-n.md`). Shrinking scope is a decision,
   not a side effect of autonomy.
4. **Specify.** Write specs under `evidence/specs/` and list them in the spec ledger with a
   permanent id `SPEC-<CATEGORY>-<name>-NN` and a layer:
   - `implementation` — the code as it is, technology-specific, kept as evidence;
   - `essence` — business rules, state transitions, logical data model, use cases, validation,
     external contracts, screens and flows, reports and batches. This is the rebuild input. The
     test for this layer: would a rebuild on any target stack still need this information?

   Every claim carries `confidence` — `confirmed` (cited `path:line` that resolves inside the
   source), `inferred` (deduced from patterns), or `unknown` with an UNKNOWN class (`blocking`,
   `deferred`, `out_of_scope`, `undecidable`, `partial`). "All / only / none" claims set
   `universal: true` and declare the population they were counted over. `evaluation` and
   `rebuild` purposes need at least one essence-layer spec.

5. **Audit — independent verification.** An agent other than the spec author (the checker
   compares `verifier_actor_id` with `author_actor_id`) re-reads each claim against the source
   and judges whether the cited line actually supports it: `supported`, `partial` (with a note),
   `unsupported` or `fabricated`. `rebuild` verifies every confirmed and inferred claim;
   `maintenance` and `evaluation` verify at least `min(confirmed, 30)` confirmed claims and
   declare the population. No `unsupported` or `fabricated` verdict may stay open — correct or
   downgrade the claim, then re-verify. The checker recomputes the source fingerprint and fails
   if the analyzed source changed since the code graph was frozen.

## Purpose presets

| Purpose       | Use                                | Extra requirement                                   |
| ------------- | ---------------------------------- | --------------------------------------------------- |
| `maintenance` | Understand and maintain the system | Sampled verification                                |
| `evaluation`  | Estimate or assess a rebuild       | Essence-layer spec required; sampled verification   |
| `rebuild`     | Spec deep enough to implement from | Essence layer; every claim verified (5–7× the cost) |

Start with a small target (under ~10k lines) in `maintenance` to measure token use before
widening the scope.

## Human holds

The workflow stops for a person at scope confirmation, at the denominator freeze and at
delivery (`human_override`). Also stop and raise a decision when: the denominator would shrink
or change after the freeze; a document conflicts with the code at the design level (not a single
drift); the same contradiction has three hypotheses or spans two sessions; a large piece of work
appears that is not in the plan; or verification does not converge in three rounds.

## Limits and handling

- Static reading only. Behavior decided at runtime or by configuration that the code cannot
  settle stays UNKNOWN. A rebuilt system still needs acceptance and regression tests against the
  current one — that is the `legacy_migration` parity phase.
- Gates prove form, not truth: a sampled re-check of a fully gated spec still finds errors in a
  few percent of claims. Report the measured error rate rather than claiming zero.
- Specs contain code excerpts: handle them at the same data tier as the source and never publish
  them to a lower tier. Analyze untrusted code in an isolated environment without production
  credentials, and do not auto-approve operations.

## Related

- [engineering-legacy-migration-playbook](./engineering-legacy-migration-playbook.md) — rebuild
  from an audited `rebuild`-purpose spec.
- [engineering-refactoring-playbook](./engineering-refactoring-playbook.md) — structure-only
  change of the same code base.
