# Voice Profile Directory

This directory is the canonical source for governed voice profiles.
It mirrors the active runtime store under `active/shared/runtime/voice-profiles/`, which is what the live voice flows read after promotion.

Rules:

- One profile per file.
- File name must match the single `profile_id` in the file.
- Each file must contain the same registry schema as the snapshot, but with exactly one profile.
- `knowledge/product/governance/voice-profile-registry.json` remains as a compatibility snapshot.
- `active/shared/tmp/voice-sample-collection/` is staging only and is not the final voice-profile store.

Runtime loaders read the directory first when the default public registry is active.
