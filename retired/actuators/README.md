# retired/actuators/

Retired actuators whose code is preserved for historical reference but are no longer part of the active build.

## Why keep the code?

Git history alone is not always searchable. Keeping the code visible in the tree (outside `libs/`) lets future contributors understand what existed and why it was retired without needing to `git log` into old SHAs.

## Entries

| Directory | Retired | Reason |
|---|---|---|
| `physical-bridge/` | 2026-05-28 | Replaced by direct ADF orchestration over `browser-actuator`, `system-actuator`, and `media-generation-actuator`. All entry points throw `physical-bridge is retired` — no callers remain. |

## How to resume or reference

- Historical behavior is documented in `physical-bridge/src/index.ts` header.
- Migration path: express cross-actuator work directly as ADF pipeline steps with `browser:`, `system:`, and `media-generation:` ops.
