# Model Registry Canonical Directory

This directory is the canonical source for individual model registry entries.

- `index.json` owns the registry version, default model, and deterministic model order.
- One model entry is stored per JSON file.
- The file name is `model-<lowercase-hex(model_id)>.json`, an injective portable encoding; the entry remains the source of truth for the canonical ID.
- `knowledge/product/governance/model-registry.json` is a generated compatibility snapshot.
- Runtime loaders read this directory first and fall back to the snapshot only when the directory is absent.

After changing an item or `index.json`, run:

```sh
pnpm sync:model-registry
pnpm run check:governance-rules
```

The governance check fails when the directory and snapshot diverge.
