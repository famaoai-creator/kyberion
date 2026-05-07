# Generated Patterns

This directory holds **distilled, promoted patterns** emitted by the memory promotion workflow (see `libs/core/promoted-memory.ts` and `libs/core/memory-promotion-workflow.ts`).

A record only lands here when its source candidate passes the value threshold in `isMeaningfulPromotionCandidate`:

- Track is not a test track (`TRK-TEST-*`).
- Title is specific (≥ 8 chars, not a generic fallback like "Reusable pattern").
- Summary is meaningful (≥ 25 chars).
- The candidate provided at least one of `applicability`, `reusable_steps`, `expected_outcome` in metadata — i.e. distillation actually produced content beyond the fallback templates.

Records that fail the threshold are marked `archived` in the distill candidate registry and `rejected` in the memory promotion queue, with the reason logged. They never reach this directory.

**This directory was reset on 2026-05-07** because 92 prior records were 100% generic fallback content from accumulated test runs (`TRK-TEST-REL1` track, identical "Reusable pattern" body). The new threshold prevents that recurrence; tests now use `TRK-DEMO-*` tracks and clean up after themselves.

If you want to view a sample record, run an end-to-end distillation against a real mission with rich metadata.
