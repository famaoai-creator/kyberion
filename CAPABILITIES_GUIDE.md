# Kyberion Capabilities Guide

Total Actuators: 27
Last updated: 2026-05-14

This guide is generated from `libs/actuators/*/manifest.json`. It is the human-readable counterpart to the compatibility snapshot `knowledge/public/orchestration/global_actuator_index.json`.

Legacy or conceptual capability names are intentionally excluded here. If a component is not manifest-backed, it is not part of the current runtime catalog.

**Recent additions (2026-05-14):**
- [Pipeline Scheduling](#pipeline-scheduling-schedule-field) — `schedule` field on ADF files; run any pipeline on a cron without extra scripts
- [Step Hooks](#step-hooks-hooks-field-on-steps) — `hooks.before` / `hooks.after` on any step; approval gates, notifications, health checks
- `pipelines/examples/` — three runnable sample pipelines demonstrating both features

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

Resilience notes:

- `service-actuator` now declares `resilience_tier: adaptive_retry` in its manifest.
- The default retry policy is exponential backoff with jitter and applies only to transient failures.
- Presets can override `recovery_policy.retry` when a service needs slower or faster backoff.
- Fallback remains sequential across preset alternatives, so the engine can still move from API to CLI or another transport when one path is unavailable.

See `libs/actuators/service-actuator/examples/` for copy-paste pipeline snippets.

**Why not curl?** curl works once but encodes credentials inline, is not replayable as an ADF contract, and can't participate in the mission audit trail. `service:preset` is idempotent, secrets stay in keychain, and the same JSON step replays identically across agents and pipeline runs.

## Pipeline Scheduling (`schedule` field)

Add a `schedule` field to any pipeline ADF to make it run automatically. The chronos daemon (`pnpm chronos`) picks it up — no registration step needed.

**When to use:**
- Recurring reports, digests, health checks (use `cron`)
- Routine syncs that run every N minutes (use `interval`)
- Replacing "run this manually each morning" instructions with ADF

**Minimal example:**

```json
{
  "name": "daily-knowledge-digest",
  "schedule": { "cron": "0 9 * * 1-5", "timezone": "Asia/Tokyo" },
  "steps": [
    { "op": "wisdom:knowledge_search", "type": "capture",
      "params": { "query": "本日対応", "knowledge_tier": "confidential", "export_as": "hits" } },
    { "op": "presence:dispatch", "type": "apply",
      "params": { "channel": "slack", "payload": "📋 Daily digest: {{hits}}" } }
  ]
}
```

**`schedule` field reference:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `cron` | yes | — | 5-field cron expression (minute hour day month weekday) |
| `timezone` | no | local | IANA timezone string, e.g. `"Asia/Tokyo"` |
| `enabled` | no | `true` | Set `false` to pause without removing the field |
| `id` | no | filename (without `.json`) | Override the registry key |

**Cron quick reference:**

| Pattern | Meaning |
|---------|---------|
| `0 9 * * 1-5` | Weekdays at 09:00 |
| `*/15 * * * *` | Every 15 minutes |
| `0 8 * * 1` | Every Monday at 08:00 |
| `30 17 * * 5` | Every Friday at 17:30 |
| `0 0 1 * *` | First day of month at midnight |

**LLM note:** The chronos daemon re-scans `pipelines/` on every tick, so editing the `schedule` field takes effect within 60 seconds without restarting the daemon. `lastRun` and `lastStatus` are persisted to `active/shared/runtime/pipeline-schedules.json`.

See `pipelines/examples/scheduled-daily-digest.json` for a complete runnable example.

---

## Step Hooks (`hooks` field on steps)

Any pipeline step can declare `before` and/or `after` hook lists. Hooks run synchronously around the step; a hook returning `abort` stops the entire pipeline.

**When to use:**
- Gate a destructive step behind human approval (`before` + `actuator_op: approval:create`)
- Send a Slack notification when a specific step completes (`after` + `actuator_op: presence:dispatch`)
- Verify external service availability before an expensive API call (`before` + `http` or `command`)
- Post an audit webhook whenever a sensitive file is written (`after` + `http`)

**Structure:**

```json
{
  "op": "artifact:write_json",
  "params": { "logicalPath": "public/reports/out.json", "value": "{{report}}" },
  "hooks": {
    "before": [
      {
        "type": "actuator_op",
        "label": "approval-gate",
        "op": "approval:create",
        "params": { "channel": "slack", "draft": "Publish report to public?", "requestedBy": "pipeline" },
        "on_reject": "abort"
      }
    ],
    "after": [
      {
        "type": "actuator_op",
        "label": "notify-published",
        "op": "presence:dispatch",
        "params": { "channel": "slack", "payload": "✅ Published: public/reports/out.json" },
        "on_reject": "warn"
      }
    ]
  }
}
```

**Hook types:**

| `type` | Required fields | Abort trigger |
|--------|----------------|---------------|
| `actuator_op` | `op` (domain:action), `params` | Actuator throws, or result context has `decision:"rejected"` / `approved:false` |
| `http` | `url` | Non-2xx response, or response body `{ "decision": "abort" }` |
| `command` | `cmd` (bash) | Exit code `2` (explicit abort); other non-zero triggers `on_reject` |

**`on_reject` values:**

| Value | Behaviour when hook signals rejection |
|-------|--------------------------------------|
| `abort` (default) | Stop the pipeline immediately, record step as failed |
| `skip` | Skip the current step, continue to next |
| `warn` | Log a warning, execute the step anyway |

**`before` hook decision flow:**

```
before hooks run in order
  → 'abort'  ──→ pipeline.status = 'failed', return immediately
  → 'skip'   ──→ skip this step, continue to next step
  → 'continue'→ execute step normally
```

**`after` hook decision flow:**

```
step executes successfully
after hooks run in order
  → 'abort'  ──→ pipeline.status = 'failed', return immediately
  → 'skip'   ──→ (treated as continue — skipping after effects is unusual)
  → 'continue'→ proceed to next step
```

**`{{ctx}}` variables in hook params:**

Hook params support the same `{{variable}}` interpolation as step params. This means you can reference the step's output in an `after` hook:

```json
{
  "op": "wisdom:knowledge_export",
  "type": "capture",
  "params": { "query": "monthly report", "export_as": "report_path" },
  "hooks": {
    "after": [{
      "type": "http",
      "url": "https://hooks.slack.com/services/...",
      "body": { "text": "Report written to: {{report_path}}" },
      "on_reject": "warn"
    }]
  }
}
```

**LLM note:** Hooks do not appear in the pipeline `results` array — they are transparent to the pipeline runner's success/failure accounting. Only the step itself appears in results. If you need hook execution to be auditable, use `approval:create` (which writes to the approval store) or `presence:dispatch` (which writes to the Slack thread).

See `pipelines/examples/` for runnable patterns:
- `approval-gated-publish.json` — human approval before a sensitive write
- `health-check-before-sync.json` — external API health gate
- `scheduled-daily-digest.json` — scheduling + after-hook notification together

---

## Path Security

All file I/O is governed by `libs/core/secure-io.ts`. Allowed paths depend on the active persona and authority role. If you see a `[ROLE_VIOLATION]` error, consult the policy definition at:

```
knowledge/public/governance/security-policy.json
```

Output paths must be **inside the project root**. To deliver a file externally, write to `active/shared/tmp/` or `active/shared/exports/` first, then copy it outside with a shell step.

| Actuator | Description | Version | Ops | Contract Schema | Path |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `agent-actuator` | Meta-Actuator for Agent Lifecycle and A2A with adaptive retry | 1.0.0 | 6 | `schemas/agent-action.schema.json` | `libs/actuators/agent-actuator` |
| `android-actuator` | ADB-driven Android Device Actuator with adaptive retry on adb/file boundaries | 1.0.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/android-actuator` |
| `approval-actuator` | Human approval request state transitions and decision handling with adaptive retry for read/list operations | 1.0.0 | 4 | `schemas/approval-action.schema.json` | `libs/actuators/approval-actuator` |
| `artifact-actuator` | Governed Artifact and Delivery Pack Manager with adaptive retry | 1.0.0 | 4 | `schemas/artifact-action.schema.json` | `libs/actuators/artifact-actuator` |
| `blockchain-actuator` | Immutable Ledger Anchoring System with adaptive retry | 1.0.0 | 2 | `schemas/blockchain-action.schema.json` | `libs/actuators/blockchain-actuator` |
| `browser-actuator` | Pipeline-driven Playwright browser execution and session artifact actuator with selector retry / self-healing waits | 1.0.0 | 2 | `schemas/browser-pipeline.schema.json` | `libs/actuators/browser-actuator` |
| `calendar-actuator` | macOS Calendar.app integration using JXA for cross-account schedule coordination with adaptive retry | 1.0.0 | 3 | `schemas/calendar-action.schema.json` | `libs/actuators/calendar-actuator` |
| `code-actuator` | ADF-driven code analysis and refactoring pipeline engine with adaptive retry on code I/O boundaries | 2.1.0 | 2 | `schemas/code-pipeline.schema.json` | `libs/actuators/code-actuator` |
| `file-actuator` | Generic File-Actuator for Kyberion with adaptive retry on filesystem boundaries | 1.0.0 | 1 | `schemas/file-pipeline.schema.json` | `libs/actuators/file-actuator` |
| `ios-actuator` | simctl-driven iOS Simulator Actuator with adaptive retry on simulator boundaries | 1.0.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/ios-actuator` |
| `media-actuator` | Document and asset generation engine with adaptive retry. Includes document_digest, pptx_slide_text, and pptx_filter_slides for template-inheriting partial-update workflows. | 1.1.0 | 1 | `schemas/media-pipeline.schema.json` | `libs/actuators/media-actuator` |
| `media-generation-actuator` | Generative image, video, music, and screen capture actuator with adaptive retry and job recovery | 1.1.0 | 10 | `schemas/media-generation-action.schema.json` | `libs/actuators/media-generation-actuator` |
| `meeting-actuator` | Abstracted online meeting bridge (Zoom, Teams, Google Meet) with adaptive retry | 1.0.0 | 6 | `schemas/meeting-action.schema.json` | `libs/actuators/meeting-actuator` |
| `meeting-browser-driver` | Playwright MeetingJoinDriver for Meet (primary) + Zoom/Teams (selectors-as-config) with adaptive retry. Implements libs/core MeetingJoinDriver and writes captured audio to an AudioBus. | 1.0.0 | 2 | `-` | `libs/actuators/meeting-browser-driver` |
| `modeling-actuator` | Architectural Analysis and ADF Transformation Engine with adaptive retry on code and model I/O boundaries | 1.0.0 | 2 | `schemas/modeling-pipeline.schema.json` | `libs/actuators/modeling-actuator` |
| `network-actuator` | ADF-driven secure fetch and A2A transport pipeline engine with transient network retry | 2.2.0 | 1 | `schemas/network-pipeline.schema.json` | `libs/actuators/network-actuator` |
| `orchestrator-actuator` | Mission/control-plane transformation and execution-plan orchestration actuator with adaptive retry | 1.0.0 | 2 | `schemas/orchestrator-pipeline.schema.json` | `libs/actuators/orchestrator-actuator` |
| `presence-actuator` | Human Presence and Messaging Bridge with adaptive retry | 1.0.0 | 3 | `schemas/presence-action.schema.json` | `libs/actuators/presence-actuator` |
| `process-actuator` | Managed process lifecycle actuator backed by the runtime supervisor with adaptive retry | 1.0.0 | 4 | `schemas/process-action.schema.json` | `libs/actuators/process-actuator` |
| `secret-actuator` | OS Native Secret Manager Bridge with adaptive retry | 1.0.0 | 3 | `schemas/secret-action.schema.json` | `libs/actuators/secret-actuator` |
| `service-actuator` | Unified External SaaS/API/MCP Reachability Layer with adaptive retry and auth-aware recovery policies | 1.1.0 | 7 | `schemas/service-action.schema.json` | `libs/actuators/service-actuator` |
| `system-actuator` | OS-level control, diagnostics, and short-lived local execution with adaptive retry | 1.1.0 | 3 | `schemas/system-pipeline.schema.json` | `libs/actuators/system-actuator` |
| `terminal-actuator` | PTY-driven Terminal Actuator with adaptive retry for read operations | 1.0.0 | 5 | `schemas/terminal-action.schema.json` | `libs/actuators/terminal-actuator` |
| `video-composition-actuator` | Governed deterministic composed-video bundle preparation actuator with adaptive retry on bundle and render boundaries | 1.0.0 | 6 | `-` | `libs/actuators/video-composition-actuator` |
| `vision-actuator` | Perception-oriented compatibility facade; generation and screen capture live in media-generation-actuator with adaptive retry | 1.3.0 | 2 | `schemas/vision-action.schema.json` | `libs/actuators/vision-actuator` |
| `voice-actuator` | Governed local voice generation actuator with native playback, artifact fallback, and adaptive retry | 1.2.0 | 7 | `schemas/voice-action.schema.json` | `libs/actuators/voice-actuator` |
| `wisdom-actuator` | Knowledge-tier search, injection, import/export, and decision-support operations with boundary retry on external command and knowledge package operations | 1.1.0 | 32 | `schemas/wisdom-action.schema.json` | `libs/actuators/wisdom-actuator` |

### Capture ops (type: capture)

| Op | Notes |
| :--- | :--- |
| `screenshot` | screen capture |
| `clipboard_read` | clipboard read |
| `get_focused_input` | focus inspection |
| `get_screen_size` | display bounds |
| `window_list` | application windows |
| `chrome_tab_list` | browser tabs |
| `read_file` | file read |
| `read_json` | json read |
| `probe` | environment probe |
| `glob_files` | filesystem glob |
| `scan_directory` | directory scan |
| `pulse_status` | ledger integrity probe |
| `exec` | governed shell capture |
| `shell` | governed shell capture |
| `cli_health_check` | cli health check |
| `list_missions` | mission list |
| `list_projects` | project list |
| `list_capabilities` | capability list |
| `list_incidents` | incident list |
| `list_knowledge` | knowledge list |
| `list_running_apps` | running apps |
| `collect_artifacts` | artifact discovery |
| `sample_traces` | trace sampling |
| `vision_consult` | vision consult |

### Transform ops (type: transform)

| Op | Notes |
| :--- | :--- |
| `regex_extract` | regex extraction |
| `json_query` | JSON path lookup |
| `sre_analyze` | root-cause analysis |
| `run_js` | guarded JavaScript transform |

### Apply ops (type: apply)

| Op | Notes |
| :--- | :--- |
| `scroll` | mouse wheel |
| `drag` | mouse drag |
| `clipboard_write` | clipboard write |
| `system_notify` | system notification |
| `open_file` | open file |
| `app_quit` | quit app |
| `process_kill` | kill process |
| `run_applescript` | applescript execution |
| `keyboard` | keyboard input |
| `paste_text` | paste text |
| `press_key` | key press |
| `voice_input_toggle` | toggle dictation/input |
| `mouse_click` | mouse click |
| `mouse_move` | mouse move |
| `activate_application` | activate app |
| `open_url` | open url |
| `write_file` | file write |
| `write_artifact` | artifact write |
| `write_json` | json write |
| `mkdir` | directory create |
| `log` | log event |
| `voice` | voice output |
| `native_tts_speak` | native tts |
| `check_native_tts` | native tts probe |
| `notify` | log notification |
| `wait` | delay |

### Control ops (type: control)

| Op | Notes |
| :--- | :--- |
| `if` | conditional branch |
| `while` | bounded loop |

See also:

- Source manifests: `libs/actuators/*/manifest.json`
- Compatibility snapshot: [global_actuator_index.json](/Users/famao/kyberion/knowledge/public/orchestration/global_actuator_index.json)
- [legacy_component_index.json](/Users/famao/kyberion/knowledge/public/orchestration/legacy_component_index.json)
- [component-lifecycle-inventory.md](/Users/famao/kyberion/knowledge/public/architecture/component-lifecycle-inventory.md)
