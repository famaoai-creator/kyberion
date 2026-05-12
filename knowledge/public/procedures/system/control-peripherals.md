# Procedure: OS Peripheral Control

## 1. Goal
Interact with the host operating system using physical peripheral emulation (keyboard, mouse), voice-input toggles, and sensory outputs (voice, notifications).

## 2. Dependencies
- **Actuator**: `System-Actuator`

## 3. Step-by-Step Instructions
1.  **Identify Action**: Determine if the task requires keyboard injection, mouse movement, dictation/voice-input toggling, voice synthesis, or an OS notification.
2.  **Keyboard Injection**:
    ```json
    {
      "action": "keyboard",
      "target_app": "iTerm2",
      "keyboard": { "text": "npm run build\n" }
    }
    ```
3.  **Mouse Interaction**:
    ```json
    {
      "action": "mouse",
      "mouse": { "type": "click", "x": 500, "y": 500 }
    }
    ```
4.  **Voice Synthesis**:
    ```json
    {
      "action": "voice",
      "voice": { "text": "Task completed successfully." }
    }
    ```
5.  **Voice Input Toggle**:
    ```json
    {
      "action": "voice_input_toggle",
      "voice_input_toggle": { "dictation_keycode": 176 }
    }
    ```
    - macOS での fallback として使います。ブラウザ側の音声入力が使えない、または対象アプリが OS dictation ショートカットを要求する場合に切り替えてください。
    - 既定の `dictation_keycode` は `176` です。キーボード配列や OS 設定が違う場合は上書きしてください。
6.  **Notifications**:
    ```json
    {
      "action": "notify",
      "notify": { "title": "Kyberion Alert", "message": "Build failed." }
    }
    ```

## 4. Expected Output
Physical execution of the requested peripheral action on the host OS.
