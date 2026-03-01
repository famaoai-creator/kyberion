# Presence Layer: Sensors, Displays, and Intervention

The **Presence Layer** is the perceptual extension of the Gemini CLI Nexus. It enables the core intelligence to perceive external events (Sensors) and project its internal state to external interfaces (Displays).

## 1. Philosophy: The Sensory Nexus

The "Nexus" is the active dialogue session between the User and the Agent in the terminal. The Presence Layer expands this Nexus by giving the Agent:
- **Ears & Eyes (Sensors)**: Ability to receive asynchronous or real-time stimuli from external sources.
- **Presence (Displays)**: Ability to manifest its thought process and knowledge in a visual or public medium.

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

Stimuli from sensors are written to `presence/bridge/stimuli.jsonl`. 

1.  **Dynamic Context Injection**: During script execution, the `system-prelude.cjs` automatically reads pending stimuli and injects them into the Agent's consciousness as a "System Whisper."
2.  **Priority Resolution**: The Agent MUST address stimuli in order of priority (Voice > Slack).
3.  **Completion**: Once a stimulus is addressed, it is marked as `PROCESSED` via the `presence-controller.cjs`.

### 3.1. Physical Intervention Protocol (Multi-Terminal)

The **Nexus Daemon** (`presence/bridge/nexus-daemon.cjs`) can physically inject stimuli into an idle terminal session using the **Terminal Bridge**.

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

## 4. 👁️ Visual Perception (SIGHT)

Provides the Agent with the ability to capture and interpret the physical state of the workspace.

### 4.1. Modular Driver Architecture
Visual sensing uses a **Driver Strategy Pattern** for cross-platform support:
- **Orchestrator (`presence/sensors/visual-sensor.cjs`)**: Detects OS and delegates to drivers.
- **Drivers**:
    - `macos-driver.cjs`: Uses native `screencapture`.
    - *Linux/Windows drivers planned.*

### 4.2. CLI Usage
Manual capture trigger:
```bash
node scripts/cli.cjs system visual-capture [screen|window]
```

## 5. 🛡️ Service Management & Watchdog

Background presence services are managed by `scripts/service_manager.cjs`.

- **Watchdog Mode**: A dedicated background process that monitors other services every 30 seconds.
- **Auto-Healing**: Automatically restarts crashed sensors or daemons.
- **Maintenance**: Periodically prunes `stimuli.jsonl` by archiving processed items older than 24 hours.

## 6. Developer Guide: Creating a New Sensor

To add a new sensory input:

1.  **Register Channel**: Update `presence/bridge/channel-registry.json`.
2.  **Write Stimulus**: Append a JSON line to `presence/bridge/stimuli.jsonl`:
    ```json
    { 
      "timestamp": "ISO-8601-TS", 
      "source_channel": "your-id", 
      "delivery_mode": "REALTIME|BATCH", 
      "payload": "Message", 
      "status": "PENDING" 
    }
    ```
3.  **Integrate**: Ensure your sensor is listed in `service_manager.cjs` for lifecycle management.
