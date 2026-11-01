---
title: 'Decision Trail Playbook — auditable attempt log without duplicating the mission ledger'
tags: [orchestration, engineering, audit, playbook, pstack]
last_updated: 2026-11-01
runtime_stages: [execution, verification]
---

# Decision Trail Playbook

Distilled from pstack `/show-me-your-work` (MIT; see [pstack-import-map](./pstack-import-map.md)).

**Do not duplicate** mission `execution-ledger.jsonl` / `record-evidence`. The ledger remains the
governance authority for task completion and review independence. A decision trail is a
**complement**: one row per scientific or design _attempt_ (hillclimb, contested design, overnight
loop) so a human can replay keep/revert choices.

## When to use

- Hillclimb / perf loops ([hillclimb-playbook](./hillclimb-playbook.md))
- Unattended or multi-phase runs the operator reviews later
- Contested design with multiple probes

Skip for ordinary single-path bug fixes already covered by ledger evidence.

## Format

Single TSV (or JSONL under mission `evidence/`), one row per decision. Cells single-line. Evidence
is a **pointer**, not prose.

| Column     | Content                                                        |
| ---------- | -------------------------------------------------------------- |
| `ts`       | ISO-8601                                                       |
| `phase`    | workstream or playbook step                                    |
| `decision` | what was chosen or done                                        |
| `why`      | plain reason (principle name only if it changed the choice)    |
| `evidence` | commit SHA, path, command artifact — never a paragraph         |
| `result`   | e.g. `kept`, `reverted`, `tests green`, `INCONCLUSIVE`, `open` |

Default location: `active/shared/tmp/<job>/decision.tsv` or mission
`evidence/decision-trail.tsv`. Commit only when stakes need an auditable record in git.

## Logging rules

- Log forks, unit completions with verification, pivots/reverts, blockers — not every keystroke
- One row per loop iteration for hillclimb
- Plain words; no AI filler
- Point `record-evidence` at the trail path when closing the parent task
