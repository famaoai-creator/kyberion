---
title: 'Recovering a Multi-Agent Research Graph from Dispatch and Reviewer Readiness Failures'
category: Evolution
tags:
  [
    'research-mission',
    'multi-agent-graph',
    'task-dispatch',
    'context-rollup',
    'review-gate',
    'gpt-5.6-luna',
  ]
importance: 6
source_mission: GE-FULL-GRAPH-LUNA-20260801
author: Kyberion Wisdom Distiller
last_updated: 2026-08-01
---

# Recovering a Multi-Agent Research Graph from Dispatch and Reviewer Readiness Failures

## Summary

The mission validated a full research graph from source collection through planner handoff and reviewer artifact production. It recovered from an initial no-dispatch run and repeated reviewer readiness failures by adding the missing agent manifest, resuming the mission, and redispatching bounded work with schema-valid context packs.

## Key Learnings

- Supervisor prewarming is not proof of graph execution; completion must be established from task_result and node_state evidence in the graph journal.
- Agent runtime readiness should be checked before graph dispatch, especially for reviewer roles whose missing or invalid manifests can block an otherwise healthy upstream handoff.
- Context rollups can keep large role-specific packs within budget while preserving scope, recipient, mission, source, redaction, and delivery constraints.
- Task completion and review acceptance are separate gates; reconciled completed_count values must not be treated as reviewer approval.

## Patterns Discovered

- A reliable recovery sequence is: diagnose missing execution evidence, repair the role manifest or readiness issue, resume the existing mission, redispatch only the affected work item, and verify the resulting journal and artifact evidence.
- Repeated empty follow-up dispatches are a control-plane signal, not harmless inactivity; they should trigger readiness and dependency inspection before another unchanged retry.
- Bounded source and consumer tasks can complete independently while a downstream review node remains blocked, allowing verified upstream results to be preserved across recovery attempts.

## Failures & Recoveries

- The initial graph ended with all tasks still planned and no task_result or node_state evidence despite successful prewarming and passing implementation tests → the mission was cancelled, diagnosed at the prewarm-to-dispatch boundary, then resumed after runtime changes.
- The reviewer repeatedly failed implementation-architect runtime readiness and requested rework → upstream source and consumer completions were retained, the reviewer work item was redispatched with a pruned schema-valid context pack, and reviewer artifact evidence was ultimately verified.
- Repeated blocked and zero-dispatch cycles produced no progress → recovery shifted from unchanged retries to manifest repair, explicit work-item dispatch, and evidence-based verification.

## Reusable Artifacts

- evidence/workitem-dispatch-manifest.json
- Role-scoped context packs and context rollups under coordination/context-packs and coordination/context-rollups
- Graph journal task_result and node_state evidence used for execution verification
- Commit b305132 containing the concise source-indexed research packet

---

_Distilled by Kyberion | Mission: GE-FULL-GRAPH-LUNA-20260801 | 2026-08-01_
