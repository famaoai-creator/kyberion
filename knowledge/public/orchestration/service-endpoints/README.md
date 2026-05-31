# Service Endpoints Canonical Directory

Each file in this directory is the canonical definition for one service endpoint entry.

- File name must match the service id.
- Each file must contain exactly one service in `services`.
- `intent_aliases` may be added to make the intent-to-endpoint mapping explicit for operators.
- `knowledge/public/orchestration/service-endpoints.json` remains a compatibility snapshot.
- Directory and snapshot must stay in sync.
