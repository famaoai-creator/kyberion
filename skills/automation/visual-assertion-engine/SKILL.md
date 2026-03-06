---
name: visual-assertion-engine
description: Waits for a specific text or image pattern to appear on the screen using the 10-frame buffer.
action: wait_for
arguments: 
- name: text
type: string
description: Text to search for (OCR mode).
- name: timeout
type: number
default: 30000
description: Timeout in milliseconds.
- name: interval
type: number
default: 1000
description: Check interval in milliseconds.
category: Automation
tags: gemini-skill, vision
---

# 👁️ visual-assertion-engine (v1.0)

A "vision-enabled" assertion engine that provides real-time feedback loop for OS automation. It reads the latest screen frames from the rolling buffer and uses OCR to detect state changes.

## 🚀 Capabilities

1.  **Text Detection**: Searches for specific keywords on the screen (English/Japanese).
2.  **State Waiting**: Loops until a condition is met or a timeout occurs.
3.  **Low Latency**: Uses the existing rolling buffer (10 frames) maintained by the daemon.

## 📦 Usage Examples

```bash
# Wait until "Build Success" appears on the screen
gemini run visual-assertion-engine --text "Build Success" --timeout 60000
```
