---
title: 'Model Registry Canonical Directory'
last_updated: 2026-11-15
---

# Model Registry Canonical Directory

This directory is the canonical source for individual model registry entries.

- `index.json` owns the registry version, default model, and deterministic model order.
- One model entry is stored per JSON file.
- The file name is `model-<lowercase-hex(model_id)>.json`, an injective portable encoding; the entry remains the source of truth for the canonical ID.
- `knowledge/product/governance/model-registry.json` is a generated compatibility snapshot.
- Runtime loaders read this directory first and fall back to the snapshot only when the directory is absent.

After changing an item or `index.json`, run:

```sh
pnpm kyberion sync model-registry   # or, without a build: pnpm exec tsx scripts/sync_model_registry.ts
pnpm check -- --scope full --only governance-rules
```

The governance check fails when the directory and snapshot diverge.

## Coupled surfaces

Adding or retiring a model is not complete with the registry entry alone. Move these surfaces in the same change:

- `knowledge/product/governance/model-cost-registry.json` — token rates and aliases for new models.
- `knowledge/product/orchestration/provider-capabilities.json` — per-provider `models` / `modelCapabilities` lists (there is no generator; edit surgically to avoid re-serializing the file).
- `knowledge/product/governance/provider-config.json` — provider defaults and `runtime_defaults` when a default model changes.
- `knowledge/product/governance/reasoning-route-policy.json` — route `model_ref` values must resolve to registered models.
- `knowledge/product/governance/env-registry.json`, `docs/developer/CONFIGURATION.md`, `docs/developer/env.example` — when a model named in an env-var default changes.
- Backend code and tests that pin a default model (e.g. `libs/core/provider/opencode-cli-reasoning-backend.ts` and its tests).
