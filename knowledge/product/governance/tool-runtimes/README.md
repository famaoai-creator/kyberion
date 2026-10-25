---
title: 'Tool Runtime Registry Canonical Directory'
last_updated: 2026-10-05
---

# Tool Runtime Registry Canonical Directory

Canonical source for tool runtime records (RSP-17).

- One tool per file: `{tool_id}.json` (file name must match `tool_id`).
- Each file carries the shared envelope (`version`, `default_tool_id`) plus a
  single-element `tools` array, validating against
  `knowledge/product/schemas/tool-runtime-registry.schema.json` as-is.
- The legacy single file `tool-runtime-registry.json` has been removed
  (snapshot abolished). Loader: `libs/core/tool/tool-runtime-registry.ts`
  (`KYBERION_TOOL_RUNTIME_REGISTRY_DIR` / `KYBERION_TOOL_RUNTIME_REGISTRY_PATH`).

- `index.json` pins the canonical item order (model-registry precedent); loaders require an exact set match.

## Registration and toolsets

Add `{tool_id}.json` against the strict registry schema and add the ID to
`index.json`. Declare platforms and platform-specific installers explicitly.
Workspace packages stay versioned in `package.json` and the lockfile; provider
CLIs stay in their provider descriptors (`provider-managed-env`). Runtime state
does not create a second package/version owner. Host packages installed by brew
or winget stay on the host; their managed directory holds lifecycle evidence.

`toolsets` groups runtime dependencies for explicit operator selection.
`render` selects HyperFrames and FFmpeg, `document_review` selects Poppler and
LibreOffice. `tts` and `stt` contain alternative local engines, so applying a
whole group may install multiple alternatives. Select `--tool` for one engine.

```bash
pnpm tool:setup -- --list
pnpm tool:setup -- --toolset document_review
pnpm tool:setup -- --tool hyperframes
pnpm tool:setup -- --tool hyperframes --apply
```

Unknown groups fail before execution. Disabled/unsupported tools run no commands.
`uv pip install` targets the tool's managed venv; `uv tool install` uses
tool-specific `UV_TOOL_DIR` and `UV_TOOL_BIN_DIR`.

A trial may generate artifacts or fetch packages. Declare a read-only
`healthcheck_backend` when trial is not a safe readiness probe. Setup inspection
refuses trial package launchers and commands without probe arguments; uv-tool
installs check the managed entrypoint with `--help`. Bind consuming registries
to runtime references where supported (HyperFrames uses a media `tool_runtime`
probe). Validate the runtime registry, setup and affected consumer tests, core
build and root typecheck before publishing.

Runtime `toolsets` are dependency groups. Intent profile `enabled_toolsets`
describe requested capabilities, including native/service operations such as
playback and artifact handling. They are not installation lists or authority
grants. Optional document tools retain existing skipped-review fallbacks when
absent. Existing voice/AGY setup commands retain specialized recovery/probes.
