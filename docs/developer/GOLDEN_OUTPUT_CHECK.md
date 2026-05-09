---
title: Golden Output Check
category: Developer
tags: [testing, regression, golden, ci]
importance: 7
last_updated: 2026-05-07
---

# Golden Output Check

How Kyberion catches **semantic regressions** in pipeline output. Complementary to:

- `check:contract-schemas` — schema-level validation.
- `check:contract-semver` — actuator surface stability.
- Unit tests — per-function correctness.

The golden check answers: *"This pipeline produced X yesterday. Does it still produce X today?"*

## When to use

A pipeline belongs in the golden set when **changes to its output should be intentional and reviewed**:

- Health check / vital-check pipelines (their shape becomes a public contract).
- Reusable subroutines used by multiple downstream pipelines.
- Reference implementations that customers / FDE engineers extend.
- "First win" pipelines (they advertise what Kyberion does — they should not silently change).

A pipeline does **not** belong in the golden set when:

- Its output is non-deterministic by design (e.g. timestamps, random ids — these are filtered, but the *content* must still be stable).
- It depends on external services whose responses change (web scraping, news feeds).
- It's a one-shot demo / scratch pipeline.

## How it works

```
1. Read tests/golden/pipelines.json (the registry).
2. For each registered pipeline:
   a. Run it (with KYBERION_REASONING_BACKEND=stub for determinism).
   b. Normalize the result by eliding volatile fields (timestamps, UUIDs, traces).
   c. Hash the normalized result.
   d. Compare to tests/golden/snapshots/{id}.json.
3. If any hash differs → exit 1 with a diff hint.
```

## Registry shape (`tests/golden/pipelines.json`)

```json
[
  {
    "id": "stable-pipeline-id",
    "pipeline": "pipelines/the-pipeline.json",
    "note": "Why this is golden",
    "input": { "var": "value" },
    "ignore_paths": ["additional.field.to.ignore"]
  }
]
```

Default ignored paths are in `scripts/check_golden_output.ts::DEFAULT_IGNORE_PATHS` (timestamp, session_id, trace, etc.). Per-pipeline `ignore_paths` are merged.

## Adding a pipeline to the golden set

1. Add an entry to `tests/golden/pipelines.json`.
2. Run `pnpm tsx scripts/check_golden_output.ts` once to generate the initial snapshot under `tests/golden/snapshots/{id}.json`.
3. Inspect the snapshot — does the projection match what you'd want as the contract? If volatile fields leaked through, add them to `ignore_paths` and rebaseline.
4. Commit both the registry entry and the snapshot.

## When a check fails

```
❌ baseline-check (pipelines/baseline-check.json)
Errors:
  - baseline-check: Output changed. Compare tests/golden/snapshots/baseline-check.json with the current run.
    If the change is intentional, run with --rebaseline. Old hash: …, new: …
```

Decide:

- **Was the change intentional?**
  - Yes → `pnpm tsx scripts/check_golden_output.ts -- --rebaseline`. Commit the updated snapshot. Reviewer should see the snapshot diff in the PR.
  - No → there's a regression. Find what changed and fix it.

## Determinism

The check assumes determinism. To get there:

- Always run with `KYBERION_REASONING_BACKEND=stub` in CI. The stub returns canned content.
- Pipelines that hit external services should not be in the golden set (or their network calls should be mocked at the actuator boundary).
- Random ids and timestamps are auto-elided from the snapshot.

## Status

- [x] Script + registry framework
- [x] Initial registry entry: `baseline-check`
- [x] Run on PR via CI
- [ ] Add: voice-hello (Phase A-5 first win)
- [ ] Add: a representative browser pipeline (after stub mock for browser is in place)
