# Kyberion Capabilities Guide

Total Actuators: 30
Last updated: 2026-07-13

This guide is generated from `libs/actuators/*/manifest.json` (actuator table) and `knowledge/product/orchestration/actuator-op-discovery.json` (op tables, sourced from each actuator describeOps). Human-readable counterpart to `global_actuator_index.json`.

Legacy or conceptual capability names are intentionally excluded here. If a component is not manifest-backed, it is not part of the current runtime catalog.

| Actuator                     | Description                                                                                                                                                                                                        | Version | Ops Count | Ops                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Prerequisites                                                                              | Contract Schema                                                  | Path                                        |
| :--------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------ | :-------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- | :--------------------------------------------------------------- | :------------------------------------------ |
| `agent-actuator`             | Meta-Actuator for Agent Lifecycle and A2A                                                                                                                                                                          | 1.0.0   |     6     | `a2a, ask, health, list, spawn, team_plan`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `-`                                                                                        | `schemas/agent-action.schema.json`                               | `libs/actuators/agent-actuator`             |
| `android-actuator`           | Android Device Actuator — ADB pipeline + Android CLI for AI agents (layout, screen capture/resolve, describe, docs search)                                                                                         | 1.1.0   |     1     | `pipeline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `bin:adb, env:ANDROID_HOME, os:darwin, os:linux, os:win32`                                 | `schemas/mobile-device-pipeline.schema.json`                     | `libs/actuators/android-actuator`           |
| `approval-actuator`          | Human approval request state transitions and decision handling                                                                                                                                                     | 1.0.0   |     4     | `create, decide, list_pending, load`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `-`                                                                                        | `schemas/approval-action.schema.json`                            | `libs/actuators/approval-actuator`          |
| `artifact-actuator`          | Governed Artifact and Delivery Pack Manager                                                                                                                                                                        | 1.0.0   |     4     | `append_event, read_json, write_delivery_pack, write_json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `-`                                                                                        | `schemas/artifact-action.schema.json`                            | `libs/actuators/artifact-actuator`          |
| `blockchain-actuator`        | Local Ledger Anchoring Simulation                                                                                                                                                                                  | 1.1.0   |     3     | `anchor_mission, anchor_trust, verify_anchor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `-`                                                                                        | `schemas/blockchain-action.schema.json`                          | `libs/actuators/blockchain-actuator`        |
| `browser-actuator`           | Pipeline-driven Playwright browser execution and session artifact actuator                                                                                                                                         | 1.1.0   |     2     | `computer_interaction, pipeline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `-`                                                                                        | `schemas/browser-pipeline.schema.json`                           | `libs/actuators/browser-actuator`           |
| `build-actuator`             | iOS/Android build, test, archive and app scaffolding — the build stage of the mobile AI-DLC/SDLC loop                                                                                                              | 1.0.0   |     8     | `android_build, android_bundle, android_test, ios_archive, ios_build, ios_generate_project, ios_test, scaffold_app`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `bin:xcodebuild, bin:xcodegen, bin:xcrun, env:ANDROID_HOME, os:darwin, os:linux, os:win32` | `schemas/build-pipeline.schema.json`                             | `libs/actuators/build-actuator`             |
| `calendar-actuator`          | macOS Calendar.app integration using JXA for cross-account schedule coordination                                                                                                                                   | 1.0.0   |     3     | `create_event, list_calendars, list_events`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `-`                                                                                        | `schemas/calendar-action.schema.json`                            | `libs/actuators/calendar-actuator`          |
| `code-actuator`              | ADF-driven code analysis and refactoring pipeline engine                                                                                                                                                           | 2.2.0   |     4     | `impact_analysis, pipeline, reconcile, semgrep_scan`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `bin:semgrep, os:darwin, os:linux`                                                         | `schemas/code-pipeline.schema.json`                              | `libs/actuators/code-actuator`              |
| `email-actuator`             | Email composition and sending via macOS Mail.app (JXA) with SMTP fallback via nodemailer                                                                                                                           | 1.0.0   |     3     | `create_draft, send, send_from_file`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `-`                                                                                        | `libs/actuators/email-actuator/schemas/email-action.schema.json` | `libs/actuators/email-actuator`             |
| `file-actuator`              | Generic File-Actuator for Kyberion                                                                                                                                                                                 | 1.1.0   |     1     | `pipeline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `-`                                                                                        | `schemas/file-pipeline.schema.json`                              | `libs/actuators/file-actuator`              |
| `ios-actuator`               | simctl-driven iOS Simulator Actuator                                                                                                                                                                               | 1.1.0   |     1     | `pipeline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `bin:xcodebuild, bin:xcrun, os:darwin`                                                     | `schemas/mobile-device-pipeline.schema.json`                     | `libs/actuators/ios-actuator`               |
| `media-actuator`             | Document and asset generation engine. Includes document_digest, pptx_slide_text, and pptx_filter_slides for template-inheriting partial-update workflows.                                                          | 1.1.0   |     1     | `pipeline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `-`                                                                                        | `schemas/media-pipeline.schema.json`                             | `libs/actuators/media-actuator`             |
| `media-generation-actuator`  | Generative image, video, music, and screen capture actuator                                                                                                                                                        | 1.1.0   |    10     | `capture_screen, collect_generation_artifact, generate_image, generate_music, generate_video, get_generation_job, record_screen, run_workflow, submit_generation, wait_generation_job`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `-`                                                                                        | `schemas/media-generation-action.schema.json`                    | `libs/actuators/media-generation-actuator`  |
| `meeting-actuator`           | Abstracted online meeting bridge (Zoom, Teams, Google Meet)                                                                                                                                                        | 1.1.0   |     6     | `chat, join, leave, listen, speak, status`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `-`                                                                                        | `schemas/meeting-action.schema.json`                             | `libs/actuators/meeting-actuator`           |
| `meeting-browser-driver`     | Internal Playwright MeetingJoinDriver for Meet (primary) + Zoom/Teams (selectors-as-config). Exposes the meeting-browser-driver join_backend label and writes captured audio to an AudioBus.                       | 1.0.0   |     2     | `join, leave`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `-`                                                                                        | `-`                                                              | `libs/actuators/meeting-browser-driver`     |
| `modeling-actuator`          | Architectural Analysis and ADF Transformation Engine                                                                                                                                                               | 1.0.0   |     2     | `pipeline, reconcile`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `-`                                                                                        | `schemas/modeling-pipeline.schema.json`                          | `libs/actuators/modeling-actuator`          |
| `network-actuator`           | ADF-driven secure fetch and A2A transport pipeline engine                                                                                                                                                          | 2.2.0   |     1     | `pipeline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `-`                                                                                        | `schemas/network-pipeline.schema.json`                           | `libs/actuators/network-actuator`           |
| `orchestrator-actuator`      | Mission/control-plane transformation and execution-plan orchestration actuator                                                                                                                                     | 1.0.0   |     2     | `pipeline, reconcile`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `-`                                                                                        | `schemas/orchestrator-pipeline.schema.json`                      | `libs/actuators/orchestrator-actuator`      |
| `presence-actuator`          | Human Presence and Messaging Bridge                                                                                                                                                                                | 1.0.0   |     3     | `dispatch, dispatch_timeline, receive_event`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `-`                                                                                        | `schemas/presence-action.schema.json`                            | `libs/actuators/presence-actuator`          |
| `process-actuator`           | Managed process lifecycle actuator backed by the runtime supervisor                                                                                                                                                | 1.0.0   |     4     | `list, spawn, status, stop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `-`                                                                                        | `schemas/process-action.schema.json`                             | `libs/actuators/process-actuator`           |
| `secret-actuator`            | OS Native Secret Manager Bridge                                                                                                                                                                                    | 1.1.0   |     4     | `delete, get, list, set`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `bin:security`                                                                             | `schemas/secret-action.schema.json`                              | `libs/actuators/secret-actuator`            |
| `service-actuator`           | Unified External SaaS/API/MCP Reachability Layer                                                                                                                                                                   | 1.1.0   |     7     | `api, cli, mcp, oauth, pipeline, preset, reconcile`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `-`                                                                                        | `schemas/service-action.schema.json`                             | `libs/actuators/service-actuator`           |
| `system-actuator`            | OS-level control plane for diagnostics, input toggles, and short-lived OS actions                                                                                                                                  | 1.2.0   |    16     | `computer_interaction, control_media_devices, list_displays, list_input_devices, list_media_devices, list_service_runtimes, list_tool_runtimes, pipeline, reconcile, test_audio_inputs, test_audio_outputs, test_camera_injection, test_camera_mp4_roundtrip, test_camera_stream, test_screen_mp4_roundtrip, test_screen_stream`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `-`                                                                                        | `schemas/system-pipeline.schema.json`                            | `libs/actuators/system-actuator`            |
| `terminal-actuator`          | PTY-driven Terminal Actuator                                                                                                                                                                                       | 1.0.0   |     5     | `computer_interaction, kill, poll, spawn, write`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `-`                                                                                        | `schemas/terminal-action.schema.json`                            | `libs/actuators/terminal-actuator`          |
| `video-composition-actuator` | Governed deterministic composed-video bundle preparation actuator                                                                                                                                                  | 1.1.0   |     9     | `await_video_composition_job, compile_narrated_video_brief, compile_video_content_brief, create_narrated_intro_movie, create_narrated_video_from_content_brief, list_video_composition_templates, pipeline, prepare_video_composition, verify_rendered_video_artifact`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `-`                                                                                        | `-`                                                              | `libs/actuators/video-composition-actuator` |
| `vision-actuator`            | Perception-oriented compatibility facade; generation and screen capture live in media-generation-actuator                                                                                                          | 1.3.0   |     2     | `inspect_image, ocr_image`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `-`                                                                                        | `schemas/vision-action.schema.json`                              | `libs/actuators/vision-actuator`            |
| `voice-actuator`             | Governed local voice generation actuator with native playback and artifact fallback                                                                                                                                | 1.2.0   |     8     | `collect_and_register_voice_profile, collect_voice_samples, generate_voice, health, list_voices, record_voice_sample, register_voice_profile, speak_local`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `-`                                                                                        | `schemas/voice-action.schema.json`                               | `libs/actuators/voice-actuator`             |
| `wisdom-actuator`            | Knowledge-tier search, injection, import/export, and decision-support operations                                                                                                                                   | 1.2.1   |    37     | `a2a_fanout, a2a_roleplay, adjust_proposal, capture_intuition, compute_readiness_matrix, conduct_1on1, cross_critique, decompose_into_tasks, deploy_release, derive_test_inventory, emit_dissent_log, evaluate_architecture_ready, evaluate_customer_signoff, evaluate_qa_ready, evaluate_requirements_completeness, evaluate_task_plan_ready, execute_task_plan, extract_design_spec, extract_dissent_signals, extract_requirements, extract_test_plan, find_slides_by_owner, fork_branches, knowledge_export, knowledge_import, knowledge_inject, knowledge_search, peer_advice, perspective_fanout, pptx_diff, recommend, register_presentation_preference_profile, simulate_all, stakeholder_grid_sort, synthesize_counterparty_persona, transcribe_audio, typed_cross_critique` | `-`                                                                                        | `schemas/wisdom-action.schema.json`                              | `libs/actuators/wisdom-actuator`            |
| `working-memory-actuator`    | Volatile Knowledge Layer — CRUD + GC + index for working-memory faces (MEMORY.md, NOW.md, daily journal, weekly review, TODO). Dispatched as domain 'working-memory' in pipelines (op: 'working-memory:<action>'). | 1.1.0   |    14     | `add-action-item, build-index, complete-action-item, daily-open, list, nominate-promotion, note, read, run-gc, set-now, todo-add, todo-done, todo-rollover, weekly-open`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `-`                                                                                        | `schemas/working-memory-action.schema.json`                      | `libs/actuators/working-memory-actuator`    |

### Capture ops (type: capture)

| Op                                 | Actuators                                              |
| :--------------------------------- | :----------------------------------------------------- |
| `a2a_poll`                         | network                                                |
| `adb_health_check`                 | android                                                |
| `android_cli_describe`             | android                                                |
| `android_cli_docs_search`          | android                                                |
| `android_cli_health_check`         | android                                                |
| `android_cli_layout`               | android                                                |
| `android_cli_screen_resolve`       | android                                                |
| `capture_focused_window`           | media-generation                                       |
| `capture_foreground_activity`      | android                                                |
| `capture_runtime_session_handoff`  | android, ios                                           |
| `capture_screen`                   | media-generation                                       |
| `chrome_tab_list`                  | system                                                 |
| `cli_health_check`                 | system                                                 |
| `clipboard_read`                   | system                                                 |
| `collect_artifacts`                | system                                                 |
| `console`                          | browser                                                |
| `content`                          | browser                                                |
| `control_media_devices`            | system                                                 |
| `discover_capabilities`            | code, orchestrator                                     |
| `discover_skills`                  | code, orchestrator                                     |
| `distill_dom`                      | browser                                                |
| `evaluate`                         | browser                                                |
| `exec`                             | system                                                 |
| `exists`                           | file                                                   |
| `export_session_handoff`           | browser                                                |
| `extract_ui_tree`                  | android                                                |
| `fetch`                            | network                                                |
| `get`                              | secret                                                 |
| `get_focused_input`                | system                                                 |
| `get_generation_job`               | media-generation                                       |
| `get_screen_size`                  | system                                                 |
| `get_video_composition_job_status` | video-composition                                      |
| `get_video_composition_queue`      | video-composition                                      |
| `glob_files`                       | code, modeling, system, wisdom                         |
| `goto`                             | browser                                                |
| `health`                           | agent, voice                                           |
| `inspect_image`                    | vision                                                 |
| `json_read`                        | media                                                  |
| `knowledge_search`                 | wisdom                                                 |
| `list`                             | agent, artifact, file, process, secret, terminal       |
| `list_calendars`                   | calendar                                               |
| `list_capabilities`                | system                                                 |
| `list_displays`                    | system                                                 |
| `list_events`                      | calendar                                               |
| `list_incidents`                   | system                                                 |
| `list_input_devices`               | system                                                 |
| `list_knowledge`                   | system                                                 |
| `list_manifests`                   | agent                                                  |
| `list_media_devices`               | system                                                 |
| `list_missions`                    | system                                                 |
| `list_pending`                     | approval                                               |
| `list_projects`                    | system                                                 |
| `list_running_apps`                | system                                                 |
| `list_runtimes`                    | agent                                                  |
| `list_service_runtimes`            | system                                                 |
| `list_terminal_sessions`           | terminal                                               |
| `list_tool_runtimes`               | system                                                 |
| `list_video_composition_templates` | video-composition                                      |
| `list_voices`                      | voice                                                  |
| `list-surfaces`                    | process                                                |
| `listen`                           | meeting                                                |
| `load`                             | approval                                               |
| `network`                          | browser                                                |
| `ocr_image`                        | vision                                                 |
| `passkey_credentials`              | browser                                                |
| `passkey_events`                   | browser                                                |
| `poll`                             | terminal                                               |
| `poll_terminal`                    | terminal                                               |
| `pptx_extract`                     | media                                                  |
| `pptx_slide_text`                  | media                                                  |
| `preset`                           | service                                                |
| `probe`                            | system                                                 |
| `pulse_status`                     | system                                                 |
| `query`                            | wisdom                                                 |
| `query_elements`                   | browser                                                |
| `read`                             | file                                                   |
| `read_file`                        | code, file, modeling, system, wisdom                   |
| `read_json`                        | android, artifact, file, ios, modeling, system, wisdom |
| `read_text_file`                   | android, ios                                           |
| `sample_traces`                    | system                                                 |
| `scan_directory`                   | system                                                 |
| `screenshot`                       | browser, system                                        |
| `search`                           | file                                                   |
| `semgrep_scan`                     | code                                                   |
| `shell`                            | code, modeling, network, system, wisdom                |
| `simctl_health_check`              | ios                                                    |
| `snapshot`                         | agent, browser                                         |
| `stat`                             | file                                                   |
| `status`                           | meeting, process                                       |
| `tabs`                             | browser                                                |
| `tail`                             | file                                                   |
| `test_camera_injection`            | system                                                 |
| `test_screen_mp4_roundtrip`        | system                                                 |
| `test_screen_stream`               | system                                                 |
| `title`                            | browser                                                |
| `transcribe`                       | voice                                                  |
| `transcribe_voice_sample`          | voice                                                  |
| `url`                              | browser                                                |
| `verify_anchor`                    | blockchain                                             |
| `vision_consult`                   | system                                                 |
| `window_list`                      | system                                                 |
| `xlsx_extract`                     | media                                                  |

### Transform ops (type: transform)

| Op                                   | Actuators                                   |
| :----------------------------------- | :------------------------------------------ |
| `ajv_validate`                       | modeling                                    |
| `apply_pattern`                      | media                                       |
| `apply_theme`                        | media                                       |
| `array_count`                        | wisdom                                      |
| `compile_narrated_video_brief`       | video-composition                           |
| `compile_video_content_brief`        | video-composition                           |
| `distill_output`                     | system                                      |
| `distill_response`                   | network                                     |
| `export_adf`                         | browser                                     |
| `export_playwright`                  | browser                                     |
| `find_ui_nodes`                      | android                                     |
| `impact_analysis`                    | code                                        |
| `json_parse`                         | file                                        |
| `json_query`                         | browser, modeling, network, system, wisdom  |
| `json_update`                        | code                                        |
| `llm_decide`                         | android, browser, network, system, terminal |
| `merge_content`                      | media                                       |
| `mermaid_gen`                        | modeling                                    |
| `path_join`                          | file                                        |
| `proposal_content_from_storyline`    | media                                       |
| `proposal_storyline_from_brief`      | media                                       |
| `regex_extract`                      | browser, network, system, wisdom            |
| `regex_replace`                      | code, file, wisdom                          |
| `run_js`                             | code, system                                |
| `set`                                | android, ios, media, secret                 |
| `sre_analyze`                        | system                                      |
| `summarize_ui_tree`                  | android                                     |
| `team_plan`                          | agent                                       |
| `team_role`                          | agent                                       |
| `terraform_to_architecture_adf`      | modeling                                    |
| `terraform_to_topology_ir`           | modeling                                    |
| `test_inventory_to_browser_pipeline` | modeling                                    |
| `test_inventory_to_device_pipeline`  | modeling                                    |
| `theme_from_pptx_design`             | media                                       |
| `ui_flow_to_test_inventory`          | modeling                                    |
| `web_profile_to_ui_flow_adf`         | modeling                                    |
| `yaml_update`                        | wisdom                                      |

### Apply ops (type: apply)

| Op                                         | Actuators                                                      |
| :----------------------------------------- | :------------------------------------------------------------- |
| `a2a`                                      | agent                                                          |
| `a2a_fanout`                               | wisdom                                                         |
| `a2a_roleplay`                             | wisdom                                                         |
| `a2a_send`                                 | network                                                        |
| `activate_application`                     | system                                                         |
| `adjust_proposal`                          | wisdom                                                         |
| `anchor_mission`                           | blockchain                                                     |
| `anchor_trust`                             | blockchain                                                     |
| `android_build`                            | build                                                          |
| `android_bundle`                           | build                                                          |
| `android_cli_screen_capture`               | android                                                        |
| `android_test`                             | build                                                          |
| `api`                                      | service                                                        |
| `app_quit`                                 | system                                                         |
| `append`                                   | file                                                           |
| `append_event`                             | artifact                                                       |
| `ask`                                      | agent                                                          |
| `audit_speaker_fairness`                   | wisdom                                                         |
| `authenticate_passkey`                     | browser                                                        |
| `authenticate_with_passkey`                | android                                                        |
| `await_video_composition_job`              | video-composition                                              |
| `boot_simulator`                           | ios                                                            |
| `cancel_video_composition_job`             | video-composition                                              |
| `capture_intuition`                        | wisdom                                                         |
| `capture_screen`                           | android, ios                                                   |
| `chat`                                     | meeting                                                        |
| `check_native_tts`                         | system                                                         |
| `clear_passkey_credentials`                | browser                                                        |
| `cli`                                      | service                                                        |
| `click`                                    | browser                                                        |
| `click_first_match`                        | browser                                                        |
| `click_ref`                                | browser                                                        |
| `clipboard_write`                          | system                                                         |
| `collect_and_register_voice_profile`       | voice                                                          |
| `collect_generation_artifact`              | media-generation                                               |
| `collect_voice_samples`                    | voice                                                          |
| `compute_readiness_matrix`                 | wisdom                                                         |
| `conduct_1on1`                             | wisdom                                                         |
| `copy`                                     | file                                                           |
| `create`                                   | approval                                                       |
| `create_draft`                             | email                                                          |
| `create_event`                             | calendar                                                       |
| `create_narrated_intro_movie`              | video-composition                                              |
| `create_narrated_video_from_content_brief` | video-composition                                              |
| `cross_critique`                           | wisdom                                                         |
| `decide`                                   | approval                                                       |
| `decompose_into_tasks`                     | wisdom                                                         |
| `delete`                                   | file, secret                                                   |
| `delete_passkey`                           | browser                                                        |
| `deploy`                                   | orchestrator                                                   |
| `deploy_release`                           | wisdom                                                         |
| `derive_test_inventory`                    | wisdom                                                         |
| `dispatch`                                 | presence                                                       |
| `dispatch_timeline`                        | presence                                                       |
| `distill`                                  | wisdom                                                         |
| `docx_render`                              | media                                                          |
| `drag`                                     | system                                                         |
| `emit_dissent_log`                         | wisdom                                                         |
| `emit_session_handoff`                     | android, ios                                                   |
| `ensure_dir`                               | artifact                                                       |
| `escalate_for_review`                      | wisdom                                                         |
| `evaluate_architecture_ready`              | wisdom                                                         |
| `evaluate_customer_signoff`                | wisdom                                                         |
| `evaluate_ensemble_convergence`            | wisdom                                                         |
| `evaluate_qa_ready`                        | wisdom                                                         |
| `evaluate_requirements_completeness`       | wisdom                                                         |
| `evaluate_simulation_quality`              | wisdom                                                         |
| `evaluate_task_plan_ready`                 | wisdom                                                         |
| `execute_self_action_items`                | wisdom                                                         |
| `execute_task_plan`                        | wisdom                                                         |
| `extension_session`                        | browser                                                        |
| `extract_action_items`                     | wisdom                                                         |
| `extract_design_spec`                      | wisdom                                                         |
| `extract_dissent_signals`                  | wisdom                                                         |
| `extract_requirements`                     | wisdom                                                         |
| `extract_test_plan`                        | wisdom                                                         |
| `fill`                                     | browser                                                        |
| `fill_login_form`                          | android                                                        |
| `fill_ref`                                 | browser                                                        |
| `find_slides_by_owner`                     | wisdom                                                         |
| `fork_branches`                            | wisdom                                                         |
| `generate_facilitation_script`             | wisdom                                                         |
| `generate_image`                           | media-generation                                               |
| `generate_reminder_message`                | wisdom                                                         |
| `generate_voice`                           | voice                                                          |
| `import_session_handoff`                   | browser                                                        |
| `inject_prior_knowledge`                   | wisdom                                                         |
| `input_text`                               | android                                                        |
| `input_text_into_ui_node`                  | android                                                        |
| `install_app`                              | ios                                                            |
| `ios_archive`                              | build                                                          |
| `ios_build`                                | build                                                          |
| `ios_generate_project`                     | build                                                          |
| `ios_test`                                 | build                                                          |
| `join`                                     | meeting                                                        |
| `keyboard`                                 | system                                                         |
| `kill`                                     | terminal                                                       |
| `kill_terminal`                            | terminal                                                       |
| `knowledge_export`                         | wisdom                                                         |
| `knowledge_import`                         | wisdom                                                         |
| `knowledge_inject`                         | wisdom                                                         |
| `launch_app`                               | android, ios                                                   |
| `leave`                                    | meeting                                                        |
| `list_profiles`                            | browser                                                        |
| `log`                                      | android, browser, code, ios, modeling, network, system, wisdom |
| `mcp`                                      | service                                                        |
| `mkdir`                                    | file, system                                                   |
| `mouse_click`                              | system                                                         |
| `mouse_move`                               | system                                                         |
| `move`                                     | file                                                           |
| `native_tts_speak`                         | system                                                         |
| `notify`                                   | system                                                         |
| `oauth`                                    | service                                                        |
| `open_deep_link`                           | android, ios                                                   |
| `open_file`                                | system                                                         |
| `open_url`                                 | system                                                         |
| `paste_text`                               | system                                                         |
| `peer_advice`                              | wisdom                                                         |
| `perspective_fanout`                       | wisdom                                                         |
| `pptx_diff`                                | wisdom                                                         |
| `pptx_filter_slides`                       | media                                                          |
| `pptx_patch`                               | media                                                          |
| `pptx_render`                              | media                                                          |
| `prepare_video_composition`                | video-composition                                              |
| `press`                                    | browser                                                        |
| `press_key`                                | system                                                         |
| `press_ref`                                | browser                                                        |
| `prewarm_mission`                          | agent                                                          |
| `process_kill`                             | system                                                         |
| `react_loop`                               | wisdom                                                         |
| `reasoning`                                | wisdom                                                         |
| `receive_event`                            | presence                                                       |
| `recommend`                                | wisdom                                                         |
| `reconcile`                                | service                                                        |
| `record_interaction`                       | presence, voice                                                |
| `record_voice_sample`                      | voice                                                          |
| `refresh`                                  | agent                                                          |
| `register_passkey`                         | browser                                                        |
| `register_presentation_preference_profile` | wisdom                                                         |
| `register_voice_profile`                   | voice                                                          |
| `render_hypothesis_report`                 | wisdom                                                         |
| `resize`                                   | terminal                                                       |
| `restart`                                  | agent                                                          |
| `run_applescript`                          | system                                                         |
| `run_execution_plan_set`                   | orchestrator                                                   |
| `scroll`                                   | system                                                         |
| `send`                                     | email                                                          |
| `send_from_file`                           | email                                                          |
| `set_passkey_presence`                     | browser                                                        |
| `set_passkey_user_verified`                | browser                                                        |
| `shell_command`                            | terminal                                                       |
| `shutdown`                                 | agent                                                          |
| `shutdown_all`                             | agent                                                          |
| `shutdown_simulator`                       | ios                                                            |
| `simulate_all`                             | wisdom                                                         |
| `simulate_all_ensemble`                    | wisdom                                                         |
| `spawn`                                    | agent, process, terminal                                       |
| `spawn_terminal`                           | terminal                                                       |
| `speak`                                    | meeting                                                        |
| `speak_local`                              | voice                                                          |
| `staff_mission`                            | agent                                                          |
| `stakeholder_grid_sort`                    | wisdom                                                         |
| `stop`                                     | process                                                        |
| `submit_generation`                        | media-generation                                               |
| `swipe`                                    | android                                                        |
| `synthesize_counterparty_persona`          | wisdom                                                         |
| `system_notify`                            | system                                                         |
| `tap`                                      | android                                                        |
| `tap_ui_node`                              | android                                                        |
| `task_plan_to_next_tasks`                  | wisdom                                                         |
| `tool_use`                                 | wisdom                                                         |
| `track_pending_action_items`               | wisdom                                                         |
| `transcribe_audio`                         | wisdom                                                         |
| `typed_cross_critique`                     | wisdom                                                         |
| `uncertainty_gate`                         | wisdom                                                         |
| `uninstall_app`                            | ios                                                            |
| `verify_rendered_video_artifact`           | video-composition                                              |
| `voice`                                    | system                                                         |
| `voice_input_toggle`                       | system                                                         |
| `wait`                                     | browser, system                                                |
| `wait_for_ui_node`                         | android                                                        |
| `wait_for_ui_text`                         | android                                                        |
| `wait_generation_job`                      | media-generation                                               |
| `wait_ref`                                 | browser                                                        |
| `write`                                    | file, terminal                                                 |
| `write_artifact`                           | code, file, modeling, network, system, wisdom                  |
| `write_delivery_pack`                      | artifact                                                       |
| `write_file`                               | code, file, media, modeling, network, system, wisdom           |
| `write_json`                               | artifact, system                                               |
| `write_terminal`                           | terminal                                                       |
| `xlsx_render`                              | media                                                          |

### Control ops (type: control)

| Op                             | Actuators                                              |
| :----------------------------- | :----------------------------------------------------- |
| `close_session`                | browser                                                |
| `if`                           | browser, code, file, modeling, network, system, wisdom |
| `open_tab`                     | browser                                                |
| `pause_for_operator`           | browser                                                |
| `ref`                          | browser                                                |
| `remove_passkey_authenticator` | browser                                                |
| `select_tab`                   | browser                                                |
| `select_tab_matching`          | browser                                                |
| `setup_passkey_authenticator`  | browser                                                |
| `while`                        | browser, code, file, modeling, network, system, wisdom |

## Capability Boundaries

Several use cases map to more than one actuator by name alone. This table is the tie-breaker (AC-06).

| Use case                                                            | Use this                                                              | Avoid / why                                                                                                                                                                    |
| :------------------------------------------------------------------ | :-------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen capture (general purpose)                                    | `system-actuator` (`test_screen_stream`, `test_screen_mp4_roundtrip`) | `media-generation-actuator`'s `capture_screen`/`record_screen` are scoped to generation workflows that need a recording bundled with generated output, not standalone capture. |
| Document rendering from a template (pptx/docx/pdf, partial updates) | `media-actuator`                                                      | Deterministic rendering, not generative — use `media-generation-actuator` for content that has to be authored/synthesized.                                                     |
| Generative image, video, or music                                   | `media-generation-actuator`                                           | `media-actuator` only renders from existing templates/content; it does not generate.                                                                                           |
| Assembling a narrated video from scenes/briefs                      | `video-composition-actuator`                                          | Distinct from `media-generation-actuator`'s `generate_video`, which produces a single generative video clip rather than composing a narrated sequence.                         |
| Image perception (OCR, layout/content inspection)                   | `vision-actuator` (`inspect_image`, `ocr_image`)                      | `vision-actuator` is perception-only; its generation-shaped ops are compatibility facades that forward to `media-generation-actuator`.                                         |
| One-shot OS command / shell                                         | `system-actuator` (`pipeline` → `system:exec`, `system:shell`)        | Use `process-actuator` instead if the command must be supervised or outlive the calling step.                                                                                  |
| Supervised, long-lived process (start/stop/status)                  | `process-actuator`                                                    | `system-actuator` and `terminal-actuator` do not track process lifecycle across steps.                                                                                         |
| Interactive terminal session (PTY, read/write a running shell)      | `terminal-actuator`                                                   | `system-actuator`'s `pipeline` ops run a command to completion; they do not expose an interactive PTY.                                                                         |

## Governed Core Workloads

`@agent/core` also exposes the additive marketing workload contract for G0 intake, G1 data classification, G2 claims, G3 video/text/image validation, G4 independent review, G5 shared human approval binding, G6 publication verification, risk-policy resolution, and evidence-aware Mission completion.

The workload composes the existing approval, artifact, media generation, video composition, browser, customer overlay, and Mission evidence capabilities. It does not register a marketing-specific Actuator or grant Strategy, Creative, or Review roles external publication authority.

Canonical templates: `knowledge/product/pipeline-templates/video-production.json`, `publication-review.json`, and `publish-youtube-dry-run.json`.

See also:

- Source manifests: `libs/actuators/*/manifest.json`
- Compatibility snapshot: [global_actuator_index.json](knowledge/product/orchestration/global_actuator_index.json)
- [legacy_component_index.json](knowledge/product/orchestration/legacy_component_index.json)
- [component-lifecycle-inventory.md](knowledge/product/architecture/component-lifecycle-inventory.md)
