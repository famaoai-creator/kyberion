---
title: 'Engineering Perf Playbook — measure, mantra, fix, re-measure'
tags: [orchestration, engineering, perf, verification, playbook, pstack]
last_updated: 2026-11-01
runtime_stages: [execution, verification]
---

# Engineering Perf Playbook

Distilled from pstack Perf issue (MIT; see [pstack-import-map](./pstack-import-map.md)).
One-off measured slowness. Sustained metric loops → [hillclimb-playbook](./hillclimb-playbook.md).

## Steps

1. **Capture a baseline** on the matching surface (trace, profile, or timed command). Vet the
   baseline and every later number with [benchmark-checklist-playbook](./benchmark-checklist-playbook.md).
2. **Ground hypotheses** via investigation — do not claim a ceiling without measuring.
   Try mantras cheapest-first; stop when an earlier one meets the target:
   1. Don't do it (stop unused work)
   2. Don't do it again
   3. Do it less
   4. Do it later
   5. Do it when they're not looking
   6. Do it concurrently
   7. Do it cheaper
3. **Plan from the trace.** Minimal fix; settle cross-boundary shape first. Sequence verifiable
   units — verify each attempt before the next.
4. **Compare artifacts** (before/after). "Inconclusive" or wrong-surface is not a pass.
5. **Cite the measurement** in evidence/PR (number, unit, run count, range, limiter).
6. Close via `record-evidence` with artifact paths.

## Reply shape

Baseline number, post-fix number, delta, artifact path, limiter name.
