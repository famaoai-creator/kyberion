---
title: Local Development Experience
category: Developer
tags: [dev, watch, fast-feedback, c-7]
importance: 7
last_updated: 2026-05-07
---

# Local Development Experience

How to iterate fast on Kyberion locally. Phase C'-7 of `docs/PRODUCTIZATION_ROADMAP.md`.

## Fast feedback loops

### Run a single test

```bash
pnpm vitest run libs/core/error-classifier.test.ts
```

### Run tests for a directory

```bash
pnpm vitest run libs/core/
```

### Watch mode

```bash
# Re-runs affected tests on save.
pnpm vitest watch libs/core/
```

This is the tightest feedback loop. Use it when iterating on a single area.

### Type-check without building

```bash
pnpm typecheck
```

A few seconds. Useful when you've changed types but don't yet need a built dist/.

### Build only what changed

```bash
pnpm --filter @agent/core build       # rebuild only @agent/core
pnpm --filter @agent/shared-business build
```

vs. the full `pnpm build` which rebuilds everything (~ 30 s).

### Lint only what changed

```bash
git diff --name-only main..HEAD | grep '\.ts$' | xargs pnpm exec eslint
```

vs. full `pnpm lint` which scans everything.

## When to use which

| Situation | Use |
|---|---|
| Changing a function in `libs/core/foo.ts` and its test | `pnpm vitest watch libs/core/foo.test.ts` |
| Adding types only | `pnpm typecheck` |
| Adding a new actuator | `pnpm --filter @actuators/your-actuator build` then a smoke run |
| Touching pipelines | `pnpm pipeline --input pipelines/your-pipeline.json` (with `KYBERION_REASONING_BACKEND=stub`) |
| Touching schemas | `pnpm tsx scripts/check_contract_schemas.ts` |
| Touching actuator manifest / contract | `pnpm tsx scripts/check_contract_semver.ts` |
| Touching docs | `pnpm tsx scripts/check_doc_examples.ts` (when example blocks tagged `bash check`) |
| Before committing | `pnpm validate` (full run, ~ 1 min) |
| Before opening a PR | `pnpm ci` (validate + full test) |

## Useful environment overrides

```bash
# Offline / deterministic mode — stub LLM backend
export KYBERION_REASONING_BACKEND=stub

# Override active customer
export KYBERION_CUSTOMER=demo-customer
# Customer-specific identity, connections, and onboarding artifacts resolve under customer/{slug}/ when set

# Bypass tier-guard for tests (use cautiously)
export KYBERION_PERSONA=ecosystem_architect
export MISSION_ROLE=mission_controller

# Use a specific reasoning model
export KYBERION_REASONING_BACKEND=anthropic
export ANTHROPIC_MODEL=claude-sonnet-4-5
```

## Editor setup

### VS Code

`.vscode/settings.json` (suggested, not committed):

```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "eslint.workingDirectories": [{ "mode": "auto" }],
  "files.eol": "\n",
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode"
}
```

### CLI debug

The `logger` honors `KYBERION_LOG_LEVEL`:

```bash
KYBERION_LOG_LEVEL=debug pnpm pipeline --input pipelines/baseline-check.json
```

## Common slow-down causes

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm build` takes > 60 s | Full TS rebuild | Use `pnpm --filter` for incremental |
| `pnpm vitest run` is slow | Cold module imports (workspace size) | Use `pnpm vitest watch` to keep modules cached |
| Doctor times out on `pnpm doctor` | Provider discovery scanning all CLIs | `KYBERION_REASONING_BACKEND=stub pnpm doctor` to skip |
| Path-scope policy errors in tests | Missing persona env | `export KYBERION_PERSONA=ecosystem_architect MISSION_ROLE=mission_controller` |

## What's coming (Phase C'-7 follow-up)

- [x] `pnpm dev:watch` — current narrow watch loop for `libs/core/` while iterating locally.
- [ ] `pnpm dev` — single-command workspace watch mode that rebuilds + reruns affected tests on save.
- [ ] Hot-reload for actuators in pipelines (currently each change requires a build).
- [ ] In-browser TypeScript playground for ADF authoring (Phase D' candidate).
