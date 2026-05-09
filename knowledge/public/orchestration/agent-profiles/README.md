# Agent Profile Directory

This directory is the canonical source for governed agent profiles.

Rules:

- One agent profile per file.
- File name must match the single agent id inside the file.
- Each file must contain `{ "version": "1.0.0", "agents": { "<agent-id>": { ... } } }`.
- `knowledge/public/orchestration/agent-profile-index.json` remains as a compatibility snapshot.

The directory is read first by Kyberion runtime loaders. Keep the snapshot in sync until all downstream consumers have fully migrated.
