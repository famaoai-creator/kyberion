---
title: 'Procedure: OS Peripheral Control'
last_updated: 2026-10-05
---

# Procedure: OS Peripheral Control

## 1. Goal

Interact with the host operating system using governed computer-use input (keyboard, mouse), voice-input toggles, and sensory outputs (speech, notifications).

## 2. Dependencies

- **Actuator**: `system-actuator` — the `computer_interaction` op for keyboard/mouse/dictation input (contract: `knowledge/product/schemas/computer-interaction.schema.json`); the `pipeline` op `notify` step for OS notifications.
- **Actuator**: `voice-actuator` — `speak_local` for speech output (or `pnpm kyberion speak` from the CLI).

## 3. Step-by-Step Instructions

1.  **Identify Action**: Determine if the task requires keyboard injection, mouse movement, dictation/voice-input toggling, speech output, or an OS notification. Input actions go through `computer_interaction` (`{"version": "0.1", "kind": "computer_interaction", ...}`); speech goes to voice-actuator; notifications go to a system `pipeline` step.
2.  **Keyboard Injection** (`computer_interaction`, action `type`):
    ```json
    {
      "version": "0.1",
      "kind": "computer_interaction",
      "target": { "executor": "system", "application": "iTerm2" },
      "action": { "type": "type", "text": "npm run build\n" }
    }
    ```
    - `target.application` activates the app before typing. For single keystrokes / shortcuts use `"type": "key"` with `key`.
    - When typing into a focused field, prefer the focused-input chain: `detect_focused_input` → `type_into_focused_input` → `submit_focused_input`.
3.  **Mouse Interaction** (`computer_interaction`, action `left_click`):
    ```json
    {
      "version": "0.1",
      "kind": "computer_interaction",
      "target": { "executor": "system" },
      "action": { "type": "left_click", "coordinate": { "x": 500, "y": 500 } }
    }
    ```
    - Also available: `double_click`, `right_click`, `mouse_move`, `scroll` (`scroll_delta`), and `drag` (`coordinate` → `to_coordinate`).
4.  **Speech Output** (voice-actuator `speak_local`, or the CLI):
    ```json
    {
      "action": "speak_local",
      "params": { "text": "Task completed successfully." }
    }
    ```
    - CLI equivalent: `pnpm kyberion speak "Task completed successfully."` (`--voice`, `--engine`, `--lang`, `--rate` select voice/engine/language/speed; `--out <audio-file>` renders to a file instead of playback).
5.  **Voice Input Toggle** (`computer_interaction`, action `voice_input_toggle`; macOS only):
    ```json
    {
      "version": "0.1",
      "kind": "computer_interaction",
      "target": { "executor": "system" },
      "action": { "type": "voice_input_toggle", "dictation_keycode": 176 }
    }
    ```
    - macOS での fallback として使います。ブラウザ側の音声入力が使えない、または対象アプリが OS dictation ショートカットを要求する場合に切り替えてください。
    - 既定の `dictation_keycode` は `176` です。キーボード配列や OS 設定が違う場合は上書きしてください。
6.  **Notifications** (`system-actuator` `pipeline` op, `notify` step):
    ```json
    {
      "action": "pipeline",
      "steps": [
        {
          "type": "apply",
          "op": "notify",
          "params": { "title": "Kyberion Alert", "message": "Build failed." }
        }
      ]
    }
    ```
    - `system_notify` remains as a deprecated alias for `notify`.

## 4. Expected Output

Physical execution of the requested peripheral action on the host OS.
