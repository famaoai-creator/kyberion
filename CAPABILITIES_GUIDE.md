# Kyberion Capabilities Guide

Total Actuators: 27
Last updated: 2026-05-09

This guide is generated from `libs/actuators/*/manifest.json`. It is the human-readable counterpart to the compatibility snapshot `knowledge/public/orchestration/global_actuator_index.json`.

Legacy or conceptual capability names are intentionally excluded here. If a component is not manifest-backed, it is not part of the current runtime catalog.

## Op Invocation Syntax

Actuator ops follow a **`domain:action`** convention in pipeline JSON files, where `domain` is the actuator name without the `-actuator` suffix:

```json
{ "op": "media:pptx_render", "type": "apply", "params": { ... } }
{ "op": "wisdom:knowledge_search", "type": "capture", "params": { ... } }
{ "op": "system:log", "params": { "message": "..." } }
```

Bare op names (without `:`) are normalized to `system:<op>` by the pipeline runner. The only exception is **`media-actuator`**, which exposes a self-contained sub-pipeline interpreter — its internal ops (`set`, `merge_content`, `pptx_render`, etc.) use bare names **only inside a nested pipeline passed to `media:pipeline`**. When called from a top-level pipeline file, always use the `media:` prefix.

| Context | Syntax | Example |
|---------|--------|---------|
| Top-level pipeline JSON | `"op": "<domain>:<action>"` | `"media:pptx_render"` |
| `media-actuator` internal steps | `"op": "<action>"` (bare) | `"pptx_render"` |
| Built-in pipeline runner ops | `"op": "core:<action>"` | `"core:if"`, `"core:foreach"` |

See `scripts/run_pipeline.ts → normalizePipelineOp()` for the full normalization rules.

## Connecting to External Services (service-actuator)

**Key principle**: The first time you connect to an external service you spend tokens finding the right pattern. After that, the same pattern becomes a deterministic ADF step — zero exploration cost on every subsequent run.

The workflow is:

1. **Register the secret once** (stored in OS keychain via secret-actuator):
   ```json
   { "op": "secret:set", "params": { "key": "backlog_api_key", "value": "<your-api-key>" } }
   ```

2. **Call `service:preset` in any pipeline** — no auth boilerplate, no curl, no token spent re-discovering the API:
   ```json
   {
     "op": "service:preset",
     "params": {
       "service_id": "backlog",
       "operation": "get_issues",
       "auth": "secret-guard",
       "params": {
         "space": "your-space",
         "query": { "projectId[]": [12345], "count": 50 }
       }
     }
   }
   ```

Available preset catalog: `knowledge/public/orchestration/service-presets/`

| Preset | Auth strategy | Template vars |
|--------|--------------|---------------|
| `backlog` | `api_key_query` (`apiKey=`) | `space`, `BACKLOG_API_KEY` |

See `libs/actuators/service-actuator/examples/` for copy-paste pipeline snippets.

**Why not curl?** curl works once but encodes credentials inline, is not replayable as an ADF contract, and can't participate in the mission audit trail. `service:preset` is idempotent, secrets stay in keychain, and the same JSON step replays identically across agents and pipeline runs.

## Path Security

All file I/O is governed by `libs/core/secure-io.ts`. Allowed paths depend on the active persona and authority role. If you see a `[ROLE_VIOLATION]` error, consult the policy definition at:

```
knowledge/public/governance/security-policy.json
```

Output paths must be **inside the project root**. To deliver a file externally, write to `active/shared/tmp/` or `active/shared/exports/` first, then copy it outside with a shell step.

| Actuator | Description | Version | Ops | Contract Schema | Path |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `agent-actuator` | Meta-Actuator for Agent Lifecycle and A2A | 1.0.0 | 6 | `schemas/agent-action.schema.json` | `libs/actuators/agent-actuator` |
| `android-actuator` | ADB-driven Android Device Actuator | 1.0.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/android-actuator` |
| `approval-actuator` | Human approval request state transitions and decision handling | 1.0.0 | 4 | `schemas/approval-action.schema.json` | `libs/actuators/approval-actuator` |
| `artifact-actuator` | Governed Artifact and Delivery Pack Manager | 1.0.0 | 4 | `schemas/artifact-action.schema.json` | `libs/actuators/artifact-actuator` |
| `blockchain-actuator` | Immutable Ledger Anchoring System | 1.0.0 | 2 | `schemas/blockchain-action.schema.json` | `libs/actuators/blockchain-actuator` |
| `browser-actuator` | Pipeline-driven Playwright browser execution and session artifact actuator | 1.0.0 | 2 | `schemas/browser-pipeline.schema.json` | `libs/actuators/browser-actuator` |
| `calendar-actuator` | macOS Calendar.app integration using JXA for cross-account schedule coordination | 1.0.0 | 3 | `schemas/calendar-action.schema.json` | `libs/actuators/calendar-actuator` |
| `code-actuator` | ADF-driven code analysis and refactoring pipeline engine | 2.1.0 | 2 | `schemas/code-pipeline.schema.json` | `libs/actuators/code-actuator` |
| `file-actuator` | Generic File-Actuator for Kyberion | 1.0.0 | 1 | `schemas/file-pipeline.schema.json` | `libs/actuators/file-actuator` |
| `ios-actuator` | simctl-driven iOS Simulator Actuator | 1.0.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/ios-actuator` |
| `media-actuator` | Document and asset generation engine. Includes document_digest, pptx_slide_text, and pptx_filter_slides for template-inheriting partial-update workflows. | 1.1.0 | 1 | `schemas/media-pipeline.schema.json` | `libs/actuators/media-actuator` |
| `media-generation-actuator` | Generative image, video, music, and screen capture actuator | 1.1.0 | 10 | `schemas/media-generation-action.schema.json` | `libs/actuators/media-generation-actuator` |
| `meeting-actuator` | Abstracted online meeting bridge (Zoom, Teams, Google Meet) | 1.0.0 | 6 | `schemas/meeting-action.schema.json` | `libs/actuators/meeting-actuator` |
| `meeting-browser-driver` | Playwright MeetingJoinDriver for Meet (primary) + Zoom/Teams (selectors-as-config). Implements libs/core MeetingJoinDriver and writes captured audio to an AudioBus. | 1.0.0 | 2 | `-` | `libs/actuators/meeting-browser-driver` |
| `modeling-actuator` | Architectural Analysis and ADF Transformation Engine | 1.0.0 | 2 | `schemas/modeling-pipeline.schema.json` | `libs/actuators/modeling-actuator` |
| `network-actuator` | ADF-driven secure fetch and A2A transport pipeline engine | 2.2.0 | 1 | `schemas/network-pipeline.schema.json` | `libs/actuators/network-actuator` |
| `orchestrator-actuator` | Mission/control-plane transformation and execution-plan orchestration actuator | 1.0.0 | 2 | `schemas/orchestrator-pipeline.schema.json` | `libs/actuators/orchestrator-actuator` |
| `presence-actuator` | Human Presence and Messaging Bridge | 1.0.0 | 3 | `schemas/presence-action.schema.json` | `libs/actuators/presence-actuator` |
| `process-actuator` | Managed process lifecycle actuator backed by the runtime supervisor | 1.0.0 | 4 | `schemas/process-action.schema.json` | `libs/actuators/process-actuator` |
| `secret-actuator` | OS Native Secret Manager Bridge | 1.0.0 | 3 | `schemas/secret-action.schema.json` | `libs/actuators/secret-actuator` |
| `service-actuator` | Unified External SaaS/API Reachability Layer | 1.0.0 | 6 | `schemas/service-action.schema.json` | `libs/actuators/service-actuator` |
| `system-actuator` | OS-level control, diagnostics, and short-lived local execution | 1.1.0 | 3 | `schemas/system-pipeline.schema.json` | `libs/actuators/system-actuator` |
| `terminal-actuator` | PTY-driven Terminal Actuator | 1.0.0 | 5 | `schemas/terminal-action.schema.json` | `libs/actuators/terminal-actuator` |
| `video-composition-actuator` | Governed deterministic composed-video bundle preparation actuator | 1.0.0 | 6 | `-` | `libs/actuators/video-composition-actuator` |
| `vision-actuator` | Perception-oriented compatibility facade; generation and screen capture live in media-generation-actuator | 1.3.0 | 2 | `schemas/vision-action.schema.json` | `libs/actuators/vision-actuator` |
| `voice-actuator` | Governed local voice generation actuator with native playback and artifact fallback | 1.2.0 | 7 | `schemas/voice-action.schema.json` | `libs/actuators/voice-actuator` |
| `wisdom-actuator` | Knowledge-tier search, injection, import/export, and decision-support operations | 1.1.0 | 32 | `schemas/wisdom-action.schema.json` | `libs/actuators/wisdom-actuator` |

See also:

- Source manifests: `libs/actuators/*/manifest.json`
- Compatibility snapshot: [global_actuator_index.json](/Users/famao/kyberion/knowledge/public/orchestration/global_actuator_index.json)
- [legacy_component_index.json](/Users/famao/kyberion/knowledge/public/orchestration/legacy_component_index.json)
- [component-lifecycle-inventory.md](/Users/famao/kyberion/knowledge/public/architecture/component-lifecycle-inventory.md)
