# Kyberion Capabilities Guide

Total Actuators: 26
Last updated: 2026-05-08

This is the catalog of Kyberion's execution body.

Users should normally ask Kyberion for outcomes such as:

- `このPDFをパワポにして`
- `日経新聞を開いて`
- `今週の進捗レポートを作って`

Kyberion then chooses the appropriate actuators internally.

This guide is therefore an operator and contributor reference, not the primary end-user interface.

It is generated from manifest-backed actuators and is the human-readable counterpart to `knowledge/public/orchestration/global_actuator_index.json`.

Legacy or conceptual capability names are intentionally excluded here. If a component is not manifest-backed, it is not part of the current runtime catalog.

| Actuator | Description | Version | Ops | Contract Schema | Path |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `agent-actuator` | Meta-Actuator for Agent Lifecycle and A2A | 1.0.0 | 6 | `schemas/agent-action.schema.json` | `libs/actuators/agent-actuator` |
| `android-actuator` | ADB-driven Android Device Actuator | 1.0.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/android-actuator` |
| `approval-actuator` | Human approval request state transitions and decision handling | 1.0.0 | 4 | `schemas/approval-action.schema.json` | `libs/actuators/approval-actuator` |
| `artifact-actuator` | Governed Artifact and Delivery Pack Manager | 1.0.0 | 4 | `schemas/artifact-action.schema.json` | `libs/actuators/artifact-actuator` |
| `blockchain-actuator` | Immutable Ledger Anchoring System | 1.0.0 | 2 | `schemas/blockchain-action.schema.json` | `libs/actuators/blockchain-actuator` |
| `browser-actuator` | Pipeline-driven Playwright browser execution and session artifact actuator | 1.0.0 | 2 | `schemas/browser-pipeline.schema.json` | `libs/actuators/browser-actuator` |
| `calendar-actuator` | macOS Calendar.app integration for cross-account schedule coordination | 1.0.0 | 3 | `schemas/calendar-action.schema.json` | `libs/actuators/calendar-actuator` |
| `code-actuator` | ADF-driven code analysis and refactoring pipeline engine | 2.1.0 | 2 | `schemas/code-pipeline.schema.json` | `libs/actuators/code-actuator` |
| `file-actuator` | Generic File-Actuator for Kyberion | 1.0.0 | 1 | `schemas/file-pipeline.schema.json` | `libs/actuators/file-actuator` |
| `ios-actuator` | simctl-driven iOS Simulator Actuator | 1.0.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/ios-actuator` |
| `media-actuator` | Document and asset generation engine | 1.0.0 | 1 | `schemas/media-pipeline.schema.json` | `libs/actuators/media-actuator` |
| `media-generation-actuator` | Generative image, video, music, and screen capture actuator | 1.0.0 | 11 | `schemas/media-generation-action.schema.json` | `libs/actuators/media-generation-actuator` |
| `meeting-actuator` | Abstracted online meeting bridge (Zoom, Teams, Google Meet) | 1.0.0 | 6 | `schemas/meeting-action.schema.json` | `libs/actuators/meeting-actuator` |
| `modeling-actuator` | Architectural Analysis and ADF Transformation Engine | 1.0.0 | 2 | `schemas/modeling-pipeline.schema.json` | `libs/actuators/modeling-actuator` |
| `network-actuator` | ADF-driven secure fetch and A2A transport pipeline engine | 2.2.0 | 1 | `schemas/network-pipeline.schema.json` | `libs/actuators/network-actuator` |
| `orchestrator-actuator` | Mission/control-plane transformation and execution-plan orchestration actuator | 1.0.0 | 2 | `schemas/orchestrator-pipeline.schema.json` | `libs/actuators/orchestrator-actuator` |
| `presence-actuator` | Human Presence and Messaging Bridge | 1.0.0 | 3 | `schemas/presence-action.schema.json` | `libs/actuators/presence-actuator` |
| `process-actuator` | Managed process lifecycle actuator backed by the runtime supervisor | 1.0.0 | 4 | `schemas/process-action.schema.json` | `libs/actuators/process-actuator` |
| `secret-actuator` | OS Native Secret Manager Bridge | 1.0.0 | 3 | `schemas/secret-action.schema.json` | `libs/actuators/secret-actuator` |
| `service-actuator` | Unified External SaaS/API Reachability Layer | 1.0.0 | 6 | `schemas/service-action.schema.json` | `libs/actuators/service-actuator` |
| `system-actuator` | OS-level control, diagnostics, and short-lived local execution | 2.1.0 | 30+ | `schemas/system-pipeline.schema.json` | `libs/actuators/system-actuator` |
| `terminal-actuator` | PTY-driven Terminal Actuator | 1.0.0 | 5 | `schemas/terminal-action.schema.json` | `libs/actuators/terminal-actuator` |
| `video-composition-actuator` | Governed deterministic composed-video bundle preparation actuator | 1.0.0 | 6 | N/A | `libs/actuators/video-composition-actuator` |
| `vision-actuator` | Perception-oriented compatibility facade; generation and screen capture live in media-generation-actuator | 1.3.0 | 2 | `schemas/vision-action.schema.json` | `libs/actuators/vision-actuator` |
| `voice-actuator` | Local Generative TTS Actuator (Style-Bert-VITS2) | 1.0.0 | 2 | `schemas/voice-action.schema.json" | `libs/actuators/voice-actuator` |
| `wisdom-actuator` | Knowledge-tier search, injection, import, and export actuator | 1.0.0 | 4 | `schemas/wisdom-action.schema.json` | `libs/actuators/wisdom-actuator` |

See also:

- [global_actuator_index.json](knowledge/public/orchestration/global_actuator_index.json)
- [legacy_component_index.json](knowledge/public/orchestration/legacy_component_index.json)
- [component-lifecycle-inventory.md](knowledge/public/architecture/component-lifecycle-inventory.md)

---

## system-actuator Op Catalog (v2.1.0)

Pipeline ops exposed by `system-actuator`. Use as `"op": "system:<op_name>"` in pipeline steps.

### Capture ops (type: capture)

| Op | Params | Returns | Notes |
| :--- | :--- | :--- | :--- |
| `screenshot` | `path?`, `display_index?` | `screenshot_path` | macOS only. Saves to `active/shared/runtime/computer/screenshots/` by default |
| `clipboard_read` | — | `clipboard_content` | macOS only |
| `get_focused_input` | — | `focused_input` (`{application, windowTitle, role, editable}`) | macOS only |
| `get_screen_size` | — | `screen_size` (`{width, height}`) | macOS only |
| `window_list` | `application` (required) | `window_list` (string[]) | macOS only |
| `chrome_tab_list` | `application?` (default: `Google Chrome`) | `chrome_tabs` | macOS only |
| `read_file` | `path` | `last_capture` | |
| `read_json` | `path` | `last_capture_data` | |
| `probe` | `path` | `last_probe` (`{path, exists, kind}`) | |
| `glob_files` | `dir`, `ext?` | `file_list` | |
| `scan_directory` | `path`, `pattern?`, `recursive?`, `exclude?`, `include_metadata?`, `max_depth?` | `scan_result` (`{files, count, dir}`) | |
| `exec` | `command`, `args?`, `cwd?`, `timeout_ms?`, `allow_error?` | `last_exec` | Requires `KYBERION_ALLOW_UNSAFE_SHELL=true` |
| `shell` | `cmd` | `last_capture` | Requires `KYBERION_ALLOW_UNSAFE_SHELL=true` |
| `cli_health_check` | `command`, `args?`, `timeout_ms?` | `cli_health` (`{available, stdout, status}`) | |
| `list_missions` | `status?` | `mission_list_data` | |
| `list_projects` | — | `project_list_data` | |
| `list_capabilities` | — | `capability_list_data` | |
| `list_knowledge` | — | `incident_list_data` | |
| `list_running_apps` | — | `running_apps` | |
| `collect_artifacts` | `mission_ids`, `patterns` | `artifact_collection` | |
| `sample_traces` | `count?` | `sampled_traces` | |
| `vision_consult` | `context`, `tie_break_options?` | `vision_decision` | |

### Apply ops (type: apply)

| Op | Params | Notes |
| :--- | :--- | :--- |
| `scroll` | `x`, `y`, `direction` (up/down/left/right), `amount?` | Requires `cliclick` (`brew install cliclick`) |
| `drag` | `from_x`, `from_y`, `to_x`, `to_y` | Requires `cliclick` |
| `clipboard_write` | `text` | macOS only |
| `system_notify` | `title`, `message`, `subtitle?` | macOS only |
| `open_file` | `path` | Must be within repo root |
| `app_quit` | `application` | macOS only. AppleScript-based graceful quit |
| `process_kill` | `pid` or `name`, `signal?` | Requires `KYBERION_ALLOW_UNSAFE_SHELL=true` |
| `run_applescript` | `script` | Requires `KYBERION_ALLOW_UNSAFE_SHELL=true`. Returns `applescript_result` |
| `keyboard` | `text` | |
| `paste_text` | `text` | |
| `press_key` | `key` | |
| `mouse_click` | `x`, `y`, `button?`, `click_count?` | |
| `mouse_move` | `x`, `y` | |
| `activate_application` | `application` | macOS only |
| `open_url` | `url` | http/https/file schemes only |
| `write_file` / `write_artifact` | `path`, `content`, `format?` | |
| `write_json` | `path`, `content?`, `from?` | |
| `mkdir` | `path` | |
| `log` | `message` | Alias: `system:log` |
| `voice` | `text` | |
| `native_tts_speak` | `text`, `voice?`, `rate?` | |
| `wait` | `duration_ms` | |

### Pipeline control (core domain)

| Op | Params | Notes |
| :--- | :--- | :--- |
| `core:if` | `condition`, `then`, `else?` | Condition supports string shorthand, `{from, operator, value}`, `{and/or: [...]}` |
| `core:foreach` | `items`, `do`, `as?` | Iterates array; context accumulates across iterations |
| `core:include` | `fragment`, `context?` | Includes a fragment from `pipelines/`. Circular reference detection enabled. Path must stay within `pipelines/` |
| `core:wait` | `duration_ms` | |
| `core:transform` | `script`, `input?`, `export_as?` | VM sandbox JS transform |

### Reusable fragments (`pipelines/fragments/`)

| Fragment | Required vars | Description |
| :--- | :--- | :--- |
| `fragments/clipboard-transform.json` | `transform_instruction` | LLM-transform clipboard content in-place |
| `fragments/screenshot-vision-gate.json` | `vision_question` | Screenshot + LLM yes/no gate → `vision_gate_passed` |
| `fragments/artifact-preview.json` | `artifact_path` | Open generated file + notify. `notify_title`/`notify_message` optional |
| `fragments/chrome-tab-triage.json` | — | List Chrome tabs → LLM triage suggestions → notify |
| `fragments/focused-form-fill.json` | `fill_text` | Guard-checked paste into focused input. `auto_submit`, `application` optional |
