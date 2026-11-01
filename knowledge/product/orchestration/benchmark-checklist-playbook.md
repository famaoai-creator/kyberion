---
title: 'Benchmark Checklist Playbook — vet a number before you trust or ship it'
tags: [orchestration, engineering, perf, benchmark, verification, playbook, pstack]
last_updated: 2026-11-01
runtime_stages: [execution, verification]
---

# Benchmark Checklist Playbook

Distilled from pstack `/benchmark-checklist` + Explain the Number (MIT; see
[pstack-import-map](./pstack-import-map.md)). Apply **before measuring**, and before trusting,
reporting, or acting on a speedup, regression, throughput, latency, or eval result.

## Before the run

- Write the claim you expect to ship (e.g. "export is 30% faster at p50 on the 60k-row fixture").
- Note what the script times, counts, and ignores.
- Check machine load; if noisy, interleave sides and say so.

## Seven questions

1. **Why not double?** Name the limiter from a profile or counters during a run, mapped to source —
   not a guess from reading code. If you cannot say why it is not twice as good, you do not know
   what you measured.
2. **Was it tuned?** Same production-like flags, warm/cold caches, versions, data on every side.
   Untuned side → do not pick a winner from that run.
3. **Did it break limits?** Arithmetic: bytes/s vs bandwidth, ops × cost vs cores, time saved vs
   time the changed piece took.
4. **Did it error?** Count failures; check outputs are correct, not merely present.
5. **Does it reproduce?** ≥5 alternating runs; report median and range. Gap smaller than variation
   → no measurable difference.
6. **Does it matter?** Micro result next to the end-to-end path a user waits on; report share of
   whole.
7. **Did it even happen?** Work ran inside the timed region (requests reached, rows written, results
   consumed — not discarded lazy work).

## Report

- Verdict: faster / slower / no measurable difference / **inconclusive**
- Number + unit + run count + range + limiter
- Inconclusive when limiter unnamed, side untuned, or Q4/Q7 unchecked
- Keep PR body to one primary number; put runs/range/limiter in a linked evidence artifact

## Related

- [engineering-perf-playbook](./engineering-perf-playbook.md) / [hillclimb-playbook](./hillclimb-playbook.md)
- working-philosophy: Explain the Number
