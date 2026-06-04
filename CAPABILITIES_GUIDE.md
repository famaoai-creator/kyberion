# Kyberion Capabilities Guide

Total Actuators: 28
Last updated: 2026-05-30

This guide is generated from `libs/actuators/*/manifest.json`. It is the human-readable counterpart to the compatibility snapshot `knowledge/product/orchestration/global_actuator_index.json`.

Legacy or conceptual capability names are intentionally excluded here. If a component is not manifest-backed, it is not part of the current runtime catalog.

For camera, microphone, virtual-device, and live-streaming boundaries, use
[`knowledge/product/architecture/actuator-contract-map.md`](knowledge/product/architecture/actuator-contract-map.md)
as the source of truth for `capture` / `perception` / `generation` /
`composition` / `bridge` / `bus` / `coordinator`.

| Actuator | Description | Version | Ops | Contract Schema | Path |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `agent-actuator` | Meta-Actuator for Agent Lifecycle and A2A | 1.0.0 | 6 | `schemas/agent-action.schema.json` | `libs/actuators/agent-actuator` |
| `android-actuator` | Android Device Actuator — ADB pipeline + Android CLI for AI agents (layout, screen capture/resolve, describe, docs search) | 1.1.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/android-actuator` |
| `approval-actuator` | Human approval request state transitions and decision handling | 1.0.0 | 4 | `schemas/approval-action.schema.json` | `libs/actuators/approval-actuator` |
| `artifact-actuator` | Governed Artifact and Delivery Pack Manager | 1.0.0 | 4 | `schemas/artifact-action.schema.json` | `libs/actuators/artifact-actuator` |
| `blockchain-actuator` | Immutable Ledger Anchoring System | 1.0.0 | 2 | `schemas/blockchain-action.schema.json` | `libs/actuators/blockchain-actuator` |
| `browser-actuator` | Pipeline-driven Playwright browser execution and session artifact actuator | 1.0.0 | 2 | `schemas/browser-pipeline.schema.json` | `libs/actuators/browser-actuator` |
| `calendar-actuator` | macOS Calendar.app integration using JXA for cross-account schedule coordination | 1.0.0 | 3 | `schemas/calendar-action.schema.json` | `libs/actuators/calendar-actuator` |
| `code-actuator` | ADF-driven code analysis and refactoring pipeline engine | 2.1.0 | 2 | `schemas/code-pipeline.schema.json` | `libs/actuators/code-actuator` |
| `email-actuator` | Email composition and sending via macOS Mail.app (JXA) with SMTP fallback via nodemailer | 1.0.0 | 3 | `libs/actuators/email-actuator/schemas/email-action.schema.json` | `libs/actuators/email-actuator` |
| `file-actuator` | Generic File-Actuator for Kyberion | 1.1.0 | 1 | `schemas/file-pipeline.schema.json` | `libs/actuators/file-actuator` |
| `ios-actuator` | simctl-driven iOS Simulator Actuator | 1.1.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/ios-actuator` |
| `media-actuator` | Document and asset composition/rendering engine. Higher-level composition policy lives in knowledge catalogs. | 1.1.0 | 1 | `schemas/media-pipeline.schema.json` | `libs/actuators/media-actuator` |
| `media-generation-actuator` | Generative image, video, music, and screen-capture boundary | 1.1.0 | 10 | `schemas/media-generation-action.schema.json` | `libs/actuators/media-generation-actuator` |
| `meeting-actuator` | Abstracted online meeting bridge (Zoom, Teams, Google Meet); browser join backend lives in `meeting-browser-driver` | 1.0.0 | 6 | `schemas/meeting-action.schema.json` | `libs/actuators/meeting-actuator` |
| `meeting-browser-driver` | Internal Playwright MeetingJoinDriver for Meet (primary) + Zoom/Teams (selectors-as-config). Writes captured audio to an AudioBus. | 1.0.0 | 2 | `-` | `libs/actuators/meeting-browser-driver` |
| `modeling-actuator` | Architectural Analysis and ADF Transformation Engine | 1.0.0 | 2 | `schemas/modeling-pipeline.schema.json` | `libs/actuators/modeling-actuator` |
| `network-actuator` | ADF-driven secure fetch and A2A transport pipeline engine | 2.2.0 | 1 | `schemas/network-pipeline.schema.json` | `libs/actuators/network-actuator` |
| `orchestrator-actuator` | Mission/control-plane transformation and execution-plan orchestration actuator | 1.0.0 | 2 | `schemas/orchestrator-pipeline.schema.json` | `libs/actuators/orchestrator-actuator` |
| `presence-actuator` | Human Presence and Messaging Bridge | 1.0.0 | 3 | `schemas/presence-action.schema.json` | `libs/actuators/presence-actuator` |
| `process-actuator` | Managed process lifecycle actuator backed by the runtime supervisor | 1.0.0 | 4 | `schemas/process-action.schema.json` | `libs/actuators/process-actuator` |
| `secret-actuator` | OS Native Secret Manager Bridge | 1.1.0 | 4 | `schemas/secret-action.schema.json` | `libs/actuators/secret-actuator` |
| `service-actuator` | Unified External SaaS/API/MCP Reachability Layer | 1.1.0 | 7 | `schemas/service-action.schema.json` | `libs/actuators/service-actuator` |
| `system-actuator` | OS-level control plane for diagnostics, input toggles, and short-lived OS actions | 1.2.0 | 3 | `schemas/system-pipeline.schema.json` | `libs/actuators/system-actuator` |
| `terminal-actuator` | PTY-driven Terminal Actuator | 1.0.0 | 5 | `schemas/terminal-action.schema.json` | `libs/actuators/terminal-actuator` |
| `video-composition-actuator` | Governed deterministic composed-video bundle preparation actuator | 1.0.0 | 6 | `-` | `libs/actuators/video-composition-actuator` |
| `vision-actuator` | Perception-oriented compatibility facade; inspect_image and ocr_image are the canonical public ops | 1.3.0 | 2 | `schemas/vision-action.schema.json` | `libs/actuators/vision-actuator` |
| `voice-actuator` | Governed local voice synthesis, playback, and voice-profile actuator | 1.2.0 | 7 | `schemas/voice-action.schema.json` | `libs/actuators/voice-actuator` |
| `wisdom-actuator` | Knowledge-tier search, injection, import/export, and decision-support operations | 1.2.1 | 33 | `schemas/wisdom-action.schema.json` | `libs/actuators/wisdom-actuator` |

### Capture ops (type: capture)

| Op | Notes |
| :--- | :--- |
| `screenshot` | system-actuator capture op |
| `clipboard_read` | system-actuator capture op |
| `get_focused_input` | system-actuator capture op |
| `get_screen_size` | system-actuator capture op |
| `window_list` | system-actuator capture op |
| `chrome_tab_list` | system-actuator capture op |
| `read_file` | system-actuator capture op |
| `read_json` | system-actuator capture op |
| `probe` | system-actuator capture op |
| `glob_files` | system-actuator capture op |
| `scan_directory` | system-actuator capture op |
| `pulse_status` | system-actuator capture op |
| `exec` | system-actuator capture op |
| `shell` | system-actuator capture op |
| `cli_health_check` | system-actuator capture op |
| `list_missions` | system-actuator capture op |
| `list_projects` | system-actuator capture op |
| `list_capabilities` | system-actuator capture op |
| `list_incidents` | system-actuator capture op |
| `list_knowledge` | system-actuator capture op |
| `list_running_apps` | system-actuator capture op |
| `list_input_devices` | system-actuator capture op |
| `list_displays` | system-actuator capture op |
| `list_media_devices` | system-actuator capture op |
| `list_tool_runtimes` | system-actuator capture op |
| `control_media_devices` | system-actuator capture op |
| `collect_artifacts` | system-actuator capture op |
| `sample_traces` | system-actuator capture op |
| `vision_consult` | system-actuator capture op |
| `test_screen_stream` | system-actuator capture op |
| `test_screen_mp4_roundtrip` | system-actuator capture op |
| `test_camera_injection` | system-actuator capture op |

### Transform ops (type: transform)

| Op | Notes |
| :--- | :--- |
| `regex_extract` | system-actuator transform op |
| `json_query` | system-actuator transform op |
| `sre_analyze` | system-actuator transform op |
| `run_js` | system-actuator transform op |

### Apply ops (type: apply)

| Op | Notes |
| :--- | :--- |
| `scroll` | system-actuator apply op |
| `drag` | system-actuator apply op |
| `clipboard_write` | system-actuator apply op |
| `system_notify` | system-actuator apply op |
| `open_file` | system-actuator apply op |
| `app_quit` | system-actuator apply op |
| `process_kill` | system-actuator apply op |
| `run_applescript` | system-actuator apply op |
| `keyboard` | system-actuator apply op |
| `paste_text` | system-actuator apply op |
| `press_key` | system-actuator apply op |
| `voice_input_toggle` | system-actuator apply op |
| `mouse_click` | system-actuator apply op |
| `mouse_move` | system-actuator apply op |
| `activate_application` | system-actuator apply op |
| `open_url` | system-actuator apply op |
| `write_file` | system-actuator apply op |
| `write_artifact` | system-actuator apply op |
| `write_json` | system-actuator apply op |
| `mkdir` | system-actuator apply op |
| `log` | system-actuator apply op |
| `voice` | system-actuator apply op |
| `native_tts_speak` | system-actuator apply op |
| `check_native_tts` | system-actuator apply op |
| `notify` | system-actuator apply op |
| `wait` | system-actuator apply op |

### Control ops (type: control)

| Op | Notes |
| :--- | :--- |
| `if` | system-actuator control op |
| `while` | system-actuator control op |

See also:

- Source manifests: `libs/actuators/*/manifest.json`
- Compatibility snapshot: [global_actuator_index.json](/Users/famao/kyberion/knowledge/product/orchestration/global_actuator_index.json)
- [legacy_component_index.json](/Users/famao/kyberion/knowledge/product/orchestration/legacy_component_index.json)
- [component-lifecycle-inventory.md](/Users/famao/kyberion/knowledge/product/architecture/component-lifecycle-inventory.md)
