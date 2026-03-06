---
name: voice-notifier
description: Sends voice notifications to the Sovereign using Text-to-Speech (TTS).
action: speak
arguments: 
- name: text
  type: string
  description: The text to be spoken.
- name: voice
  type: string
  description: The voice name to use (e.g., 'Kyoko' for Japanese, 'Samantha' for English).
- name: rate
  type: number
  description: The speaking rate (words per minute).
- name: urgent
  type: boolean
  description: If true, play an alert sound before speaking.
category: Automation
tags: [voice, notification, tts, native]
platforms: [darwin]
---

# 🗣️ voice-notifier (v1.0)

Provides the Gemini CLI with a voice, allowing it to notify the Sovereign of task completions, alerts, or status updates via native Text-to-Speech.

## 🚀 Capabilities

1.  **Native TTS**: Uses the OS's native speech synthesis (macOS `say`).
2.  **Multilingual Support**: Supports any voice installed on the system (e.g., `Kyoko` for high-quality Japanese).
3.  **Urgent Alerts**: Can be configured to grab attention with a preceding alert sound.

## 📦 Usage Examples

```bash
# Basic notification
gemini run voice-notifier --text "Build complete."

# Japanese notification with specific rate
gemini run voice-notifier --text "任務を完了しました。" --voice "Kyoko" --rate 250

# Urgent alert
gemini run voice-notifier --text "Critical error detected!" --urgent
```
