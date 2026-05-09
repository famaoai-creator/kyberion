# Voice Profile Directory

This directory is the canonical source for governed voice profiles.

Rules:

- One profile per file.
- File name must match the single `profile_id` in the file.
- Each file must contain the same registry schema as the snapshot, but with exactly one profile.
- `knowledge/public/governance/voice-profile-registry.json` remains as a compatibility snapshot.

Runtime loaders read the directory first when the default public registry is active.
