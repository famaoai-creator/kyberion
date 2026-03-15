---
title: Presence Layer: Sensors, Displays, and Intervention
category: Architecture
tags: [architecture, presence, layer]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Presence Layer: Sensors, Displays, and Intervention

The **Presence Layer** is the perceptual extension of the Kyberion CLI Nexus. It enables the core intelligence to perceive external events (Sensors) and project its internal state to external interfaces (Displays).

## 1. Philosophy: The Sensory Nexus

The "Nexus" is the active dialogue session between the User and the Agent in the terminal. The Presence Layer expands this Nexus by giving the Agent:
- **Ears & Eyes (Sensors)**: Ability to receive asynchronous or real-time stimuli from external sources.
- **Presence (Displays)**: Ability to manifest its thought process and knowledge in a visual or public medium.

After the mission/runtime refactor, the Presence Layer also acts as a boundary between:

- channel ingress
- interactive control surfaces
- explainable feedback delivery

## 2. Communication Channels

All external interactions are categorized by **Channels**, each defined in `presence/bridge/channel-registry.json`.

| Channel | Priority | Mode | Nature |
| :--- | :--- | :--- | :--- |
| **Terminal** | 10 | REALTIME | Primary direct interaction (Low latency). |
| **Visual** | 9 | REALTIME | Screen capture and visual state (Prototype). |
| **Voice** | 8 | REALTIME | High-priority auditory commands (Urgent). |
| **Slack** | 5 | BATCH | Asynchronous collaboration (Delayed response). |
| **Pulse** | 3 | BATCH | Background system events (Passive). |

## 3. The Intervention Protocol (How I Perceive)

Stimuli from sensors are written to the canonical runtime journal:

- `presence/bridge/runtime/stimuli.jsonl`

Channel events should also be mirrored into explainable observability streams under:

- `active/shared/observability/channels/<channel>/`

1.  **Dynamic Context Injection**: During script execution, the `system-prelude.js` automatically reads pending stimuli and injects them into the Agent's consciousness as a "System Whisper."
2.  **Priority Resolution**: The Agent MUST address stimuli in order of priority (Voice > Slack).
3.  **Completion**: Once a stimulus is addressed, it is marked as `PROCESSED` via the `presence-controller.js`.

### 3.1. Physical Intervention Protocol (Multi-Terminal)

The **Nexus Daemon** (`presence/bridge/nexus-daemon.js`) can physically inject stimuli into an idle terminal session using the **Terminal Bridge**.

- **Supported Terminals**: iTerm2 (Primary), VS Code Integrated Terminal (Fallback).
- **Trigger**: New `PENDING` stimulus detected + Terminal state is IDLE.
- **Injected Format**: 
  ```text
  [SENSORY_INPUT_BEGIN]
  Source: <channel_id>
  TS:     <timestamp>
  Payload: <<<
  <message_content>
  >>>
  [SENSORY_INPUT_END]
  ```
- **Stability**: Automatically marks stimuli as `INJECTED` in physical storage to prevent duplicates on restart.
- **Response plane**: Session results should be read from session-scoped runtime outboxes such as `active/shared/runtime/terminal/<session_id>/out/latest_response.json`, not from a global singleton response file.

## 4. Slack and Chronos responsibilities

The Presence Layer now distinguishes clearly between Slack and Chronos Mirror v2:

- **Slack** is primarily a channel sensor and channel endpoint.
- **Chronos Mirror v2** is an authenticated interactive control surface.
- Both should be described through explicit channel ports and optional Surface Agents.

Slack should normalize ingress and deliver egress. It should not own mission authority.

Chronos Mirror v2 may hold a cached runtime handle for UX efficiency, but it should not become the durable source of truth for mission state. Durable coordination belongs in:

- `active/shared/coordination/chronos/`
- `active/shared/observability/chronos/`
- mission-local `coordination/`

## 5. 👁️ Visual Perception (SIGHT)

Provides the Agent with the ability to capture and interpret the physical state of the workspace.

### 5.1. Modular Driver Architecture
Visual sensing uses a **Driver Strategy Pattern** for cross-platform support:
- **Orchestrator (`presence/sensors/visual-sensor.js`)**: Detects OS and delegates to drivers.
- **Drivers**:
    - `macos-driver.js`: Uses native `screencapture`.
    - *Linux/Windows drivers planned.*

### 5.2. CLI Usage
Manual capture trigger:
```bash
npm run cli -- system visual-capture [screen|window]
```

## 6. 🛡️ Service Management & Watchdog

Background presence services are managed by `scripts/service_manager.js`.

- **Watchdog Mode**: A dedicated background process that monitors other services every 30 seconds.
- **Auto-Healing**: Automatically restarts crashed sensors or daemons.
- **Maintenance**: Periodically prunes `stimuli.jsonl` by archiving processed items older than 24 hours.
- **Observability**: Services should emit explainable events into `active/shared/observability/` so operators can reconstruct why a channel event was routed or delayed.

## 7. Developer Guide: Creating a New Sensor

To add a new sensory input:

1.  **Register Channel**: Update `presence/bridge/channel-registry.json`.
2.  **Write Stimulus**: Append a JSON line to `presence/bridge/runtime/stimuli.jsonl`:
    ```json
    { 
      "timestamp": "ISO-8601-TS", 
      "source_channel": "your-id", 
      "delivery_mode": "REALTIME|BATCH", 
      "payload": "Message", 
      "status": "PENDING" 
    }
    ```
3.  **Mirror Observability**: Append an explainable event under `active/shared/observability/channels/<channel>/`.
4.  **Integrate**: Ensure your sensor is listed in `service_manager.js` for lifecycle management.

For the authoritative Slack and Chronos control contract, see:

- `knowledge/public/architecture/slack-chronos-control-model.md`
- `knowledge/public/architecture/channel-port-surface-model.md`
