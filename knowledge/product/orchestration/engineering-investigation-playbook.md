---
title: 'Engineering Investigation Playbook — cited how/why answers, read-only'
tags: [orchestration, engineering, investigation, playbook, pstack]
last_updated: 2026-11-01
runtime_stages: [alignment, execution]
---

# Engineering Investigation Playbook

Distilled from pstack Investigation + `/how`/`/why` posture (MIT; see
[pstack-import-map](./pstack-import-map.md)). **Read-only:** cited explanation or recommendation,
not a code change. If the answer implies a change, hand back and re-route to bug-fix / feature /
refactoring.

## How (mechanism)

Produce a cited walkthrough:

1. **Overview** — what the subsystem is for
2. **Key concepts** — types, ownership, invariants
3. **How it works** — control/data flow with `file:line` or command evidence
4. **Where things live** — modules, registries, entrypoints
5. **Gotchas** — traps that waste the next reader

Prefer computing facts (`rg`, tests, actuator reads, logs) over recall. Prefer Kyberion sense verbs
when reading artifacts.

## Why (motivation / history)

When the question is "why was this built this way?", gather evidence categories **in parallel
where cheap**, and mark each as found / missing / not applicable:

| Category              | Typical sources in Kyberion                              |
| --------------------- | -------------------------------------------------------- |
| Source control        | `git log` / blame / PR bodies                            |
| Issue / mission       | mission evidence, WorkItems, ledger notes                |
| Long-form docs        | `knowledge/` (respect tiers), ADRs                       |
| Real-time chat        | only if an approved connector exists — never invent      |
| Infra / observability | traces under `active/shared/logs/`, runtime receipts     |
| Error / analytics     | existing dashboards or logs; do not broaden tenant scope |

Cite paths and ids. A search that finds nothing is still an answer. Never invent callers or APIs.

## Decision recommendations

If the request is a choice between alternatives: tradeoffs table, recommendation, strongest dissent
(use [design-divergence-playbook](./design-divergence-playbook.md) / `devils_advocate` when stakes
are high). Push back when the premise is wrong.

## Reply shape

How-shaped sections or recommendation + tradeoffs. For "are we sure?", real judgment with reasons.
No PR ceremony for pure investigation.
