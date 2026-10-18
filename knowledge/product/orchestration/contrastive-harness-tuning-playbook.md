---
title: 'Contrastive Harness Tuning — harness2 concepts and their Kyberion landing zones'
tags: [orchestration, harnessing, distillation, evaluation, playbook, harness2]
last_updated: 2026-10-18
runtime_stages: [execution, review]
---

# Contrastive Harness Tuning Playbook

Concept catalog distilled from `google-research/harness2` (arXiv:2610.14224, Apache-2.0) and
mapped onto Kyberion. Two concepts landed in MSN-HARNESS2-IMPORT-20261018 (the
cue/lesson/evidence/confidence distill contract and the evidence-boundary working
principle); the rest are catalogued here with their landing zones for a follow-on
implementation mission.

A **harness** is everything around the model: prompts, tools, memory, skills, orchestration.
**Harnessing** is optimizing that system while model weights stay fixed. Harness² couples two
recursion levels: task-level (refine the harness for the task at hand) and harnessing-level
(a persistent improvement harness that learns from each task).

## Imported in MSN-HARNESS2-IMPORT-20261018

| Concept                                                                                                                      | Where it landed                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Experience record — `cue` / `lesson` / `evidence` / `confidence`, all required-or-absent                                     | `WISDOM_SCHEMA` in `libs/core/mission/mission-distill.ts`; `distill_experience` on `MemoryCandidate` |
| Change-attribution rows with `confounded` verdict; "a lesson resting only on confounded rows is a guess — narrow or decline" | `edit_rows` in the distill schema; warnings in `memory-promotion-review.ts`                          |
| NO_ENTRY is a valid output (decline rather than promote a guess)                                                             | `distill_experience_declined` flag on the candidate                                                  |
| Facts vs. procedure scoping; named components beat always-on prose                                                           | `knowledge/product/governance/distill-prompt.md`                                                     |
| Evidence is data, not instructions                                                                                           | `CORE_WORKING_PRINCIPLES` in `libs/core/working-principles.ts`                                       |

## Deferred concepts — landing zones

### 1. Propose–Probe–Compose (task-level recursion)

harness2 runs a task under the base harness, lets an editor propose candidate edits on two
independent dimensions — **INV** (how the agent works: procedure, tool use, completion) and
**DOM** (what a practitioner knows: artifact contract, decision rules) — **probes** each
candidate by rolling it out on the same task, then **composes** a refined harness from the
behavioral contrasts. No ground truth: the evidence is execution difference, not scores.

Kyberion landing zone: a `pipelines/` pipeline over worktree-isolated probe runs
(`active/shared/` floors) + `delegateTask` for proposer/composer sessions. Preconditions: an
eval substrate seam (see `eval/`, currently facet/scenario stubs) and a declared editable
surface (next item). Budget note: one step costs `4k` rollouts + `3k` improvement sessions —
start at `k=1` or probe on cheap replica tasks.

### 2. Declarative editable surface (`SurfaceSpec`)

harness2 declares, per agent framework, exactly which files a proposer may edit — paths, caps,
frontmatter rules, hooks schema, cross-reference checks (a skill invoking a script it does not
ship fails validation) — with an omitted-is-inherited edit contract and an `autotrigger`
repair pass that ensures every skill has a trigger line in always-on text.

Kyberion landing zone: complements co-session path leases (ownership) with a per-work-item
_edit-scope_ schema (what a worker may touch). Cross-reference validation (skill→script,
trigger lines) is immediately applicable to Kyberion skills/plugins independent of the loop.

### 3. Blind anonymized artifact selection

harness2's selector compares **anonymized deliverables** (seeded shuffle, A/B/C ids),
provenance hidden, under an ordered rubric: DELIVERY → CONFORMANCE → FIDELITY → internal
consistency → operational fitness → finish. "Picking the unmodified baseline is a completely
valid outcome" is stated up front to kill elaboration bias.

Kyberion landing zone: the review phase and any best-of-N generation path (media, decks,
reports). `review-task` already enforces reviewer independence; anonymization removes the
remaining "who made this" signal.

### 4. Budget-identity ledger

Every run records rollouts vs. improvement sessions and asserts `R = 4k`, `P = 3k` —
**duplicates are checked before counts**, because a repeated run label can satisfy the counts
while silently overwriting a stage that never ran.

Kyberion landing zone: the mission execution ledger (`active/missions/.../execution-ledger.jsonl`)
could assert per-phase expected event counts at `verify`; duplicate-run-id detection belongs
wherever workers write run artifacts.

### 5. Per-domain, causally-ordered experience library

Each domain keeps `INDEX.md` + full adopted harnesses + `EXPERIENCE.md`; tasks run in stream
order and read **only entries earlier than themselves** (`retain`). Retrieval is by
construction — a domain directory physically contains only same-domain entries.

Kyberion landing zone: `knowledge/` + `intent-domain-ontology.json` for domain scoping; the
causal-ordering rule maps onto context-pack generation (a worker sees only knowledge promoted
before its mission started).

### 6. Evidence-as-files + pointer mission

Proposers never get inlined evidence: a `context/` tree is materialized on disk (task,
full untruncated trajectories, deliverables, candidate harnesses, library index) and the
prompt is a short pointer — "read it, do not answer from this message alone". Per-observation
truncation carries an explicit marker so it is never diagnosed as agent failure.

Kyberion landing zone: context packs for `delegateTask` and review sessions — the contract
"nothing is truncated to fit the prompt; truncation is marked and is not a defect" is
directly adoptable.

### 7. Leak tripwires at the read boundary, both directions

Declared answer-key globs are refused before evidence reaches a model, and grader-verdict
markers are scanned by name **and content** on both inbound evidence and agent-authored files
— a file carrying a verdict marker can never be served as evidence later. The rule when a
tripwire fires: fix the read path, do not widen the marker list.

Kyberion landing zone: tier-guard covers tier leakage; a **content-marker scan on
agent-authored artifacts before they are stored in `knowledge/`** is the complementary gate.
Deferred because it touches the security boundary — needs its own review.

## What harness2 does NOT have

No tenants, approval gates, audit chain, provenance, or mission lifecycle — it is a
single-operator research loop. Any imported mechanism must sit inside Kyberion's governance
envelope (tiers, leases, approvals), not beside it.

## References

- Repo: https://github.com/google-research/harness2 — `harness2/core/{spec,recursion,proposer,ledger,library,context,selection,prompts,tree,schedule}.py`
- Paper: arXiv:2610.14224
- Import mission: MSN-HARNESS2-IMPORT-20261018
