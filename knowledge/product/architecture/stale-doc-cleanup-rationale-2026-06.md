# Stale Doc Cleanup Rationale

This note records why some planning documents in `docs/` can be removed after their core ideas have already landed in code or in more canonical knowledge artifacts.

## Intent learning seed cache

The old `docs/intent-learning-seed-cache-plan.md` was a migration note, not a runtime spec.

Its stable guidance is now reflected in the current intent stack:

- deterministic mappings belong in the governed `standard-intents` catalog
- procedural or security-sensitive command construction stays in code
- public seed data must be confirmed examples only
- runtime behavior should not change just because the seed cache shape is introduced

If the seed cache evolves again, the canonical place to update is the catalog and its schema checks, not the old migration note.

## Codex App integration

The old `docs/CODEX_APP_INTEGRATION_PLAN.md` described a possible app-native Codex runtime path.

Its reusable guidance is now covered by the provider discovery and adapter layer:

- discover provider-native capability before hard-coding behavior
- treat `codex app-server` as a provider capability and adapter target
- keep approval and audit rails inside Kyberion
- only introduce a separate long-lived surface if the runtime proves it needs one

The canonical references for that work are the provider capability discovery/report docs and the adapter code in `libs/core/agent-adapter.ts`.

## Cleanup rule

Delete planning docs when:

1. the behavior is already implemented or represented elsewhere
2. the remaining text is only migration commentary or duplicated reasoning
3. the useful part can be captured in a shorter knowledge note like this one
