# Invariant: degradation to stub reasoning is never silent

## Scope

- `libs/core/reasoning-backend.ts`
- `libs/core/reasoning-bootstrap.ts`

## Requirements

- When a deterministic stub serves a reasoning op **without** stub mode being explicitly requested (`KYBERION_REASONING_BACKEND=stub`), the user-visible text must name a concrete recovery action (e.g. the `pnpm reasoning:setup` command) — not merely state that a stub was used.
- Every code path where a selected non-stub mode falls back to keeping stubs must log a warning that states **which mode was selected** and **why** it could not be used (no backend buildable, no failover candidates, etc.).
- Silent degradation must leave a machine-readable record (stub-taint registry / degraded marker or operator notification), not only a log line, so completion gates and the baseline check can observe it.

## Examples

- OK: `Reasoning backend is not configured. Run \`pnpm reasoning:setup\` before using Kyberion for real work.`
- OK: `mode=anthropic selected but no usable reasoning backend could be built — keeping stubs.`
- NG: falling back to stubs with only `logger.debug('using stub')` and no persisted marker.
