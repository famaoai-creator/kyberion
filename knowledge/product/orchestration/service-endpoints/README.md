# Service Endpoints Canonical Directory

Each file in this directory is the canonical definition for one service endpoint entry.

- File name must match the service id.
- Each file must contain exactly one service in `services`.
- `intent_aliases` may be added to make the intent-to-endpoint mapping explicit for operators.
- `alias_of` may be added when the entry exists only as a compatibility alias for another canonical service id.
- `voice` and `whisper` are canonical service endpoints for synthesis / transcription; `vision` is a compatibility alias for `media-generation`.
- `comfyui` is the canonical local image-generation service endpoint and is additionally governed by the service runtime abstraction for availability and managed location tracking.
- `knowledge/product/orchestration/service-endpoints.json` remains a compatibility snapshot.
- Directory and snapshot must stay in sync.
