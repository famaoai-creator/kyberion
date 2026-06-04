# Service Endpoints Canonical Directory

Each file in this directory is the canonical definition for one service endpoint entry.

- File name must match the service id.
- Each file must contain exactly one service in `services`.
- `intent_aliases` may be added to make the intent-to-endpoint mapping explicit for operators.
- `alias_of` may be added when the entry exists only as a compatibility alias for another canonical service id.
- `service-presets/*.json` define the operation templates for each service endpoint; endpoints answer "which service is canonical", presets answer "how to call it".
- `service-actuator` consumes both endpoint and preset catalogs to resolve auth, routing, CLI/API/MCP execution, and reconciliation.
- `tool-runtime` manages executable availability for CLI-backed presets, while `service-runtime` manages the lifecycle of long-lived local services such as ComfyUI.
- `voice` and `whisper` are canonical service endpoints for synthesis / transcription; `vision` is a compatibility alias for `media-generation`.
- `comfyui` is the canonical local image-generation service endpoint and is additionally governed by the service runtime abstraction for availability and managed location tracking.
- `knowledge/product/orchestration/service-endpoints.json` remains a compatibility snapshot.
- Directory and snapshot must stay in sync.
