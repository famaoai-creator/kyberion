# Procedure: OS Peripheral Control

## 1. Goal
Interact with the host operating system using physical peripheral emulation (keyboard, mouse) and sensory outputs (voice, notifications).

## 2. Dependencies
- **Actuator**: `System-Actuator`

## 3. Step-by-Step Instructions
1.  **Identify Action**: Determine if the task requires keyboard injection, mouse movement, voice synthesis, or an OS notification.
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
5.  **Notifications**:
    ```json
    {
      "action": "notify",
      "notify": { "title": "Kyberion Alert", "message": "Build failed." }
    }
    ```

## 4. Expected Output
Physical execution of the requested peripheral action on the host OS.
