# Surface Provider Manifest Catalog Directory

This directory is the canonical source for surface provider manifest catalog entries.

Rules:

- One provider entry per file.
- File name must match the single `id` inside the file.
- Each file must contain exactly one entry in `entries`.
- `knowledge/public/governance/surface-provider-manifest-catalog.json` remains as a compatibility snapshot.

Keep the snapshot aligned with the directory until all downstream consumers migrate.
