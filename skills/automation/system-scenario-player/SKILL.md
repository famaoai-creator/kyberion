---
name: system-scenario-player
description: Global speed multiplier for delays.
action: play
arguments: 
- name: speed
type: number
default: 1.0
category: Utilities
tags: gemini-skill
---

# 🧠 system-scenario-player (v1.0)

A brain-like orchestrator for the Gemini CLI that executes complex system-level automation scenarios. It coordinates "muscle" skills like `keyboard-injector` and `mouse-injector` to perform multi-step workflows on the OS.

## 🚀 Capabilities

1.  **Step-by-Step Execution**: Runs a sequence of automation actions in order.
2.  **Wait Handling**: Can insert pauses between actions for UI to respond.
3.  **Skill Chaining**: Automatically routes steps to the correct underlying skills.
4.  **Global Scaling**: Adjust automation speed globally.

## 📦 Scenario Format (Example)

```json
[
  { "type": "keyboard", "text": "npm build", "keys": ["enter"] },
  { "type": "wait", "ms": 2000 },
  { "type": "mouse", "x": 100, "y": 200, "click": "left" }
]
```

## 📦 Usage Examples

```bash
# Run a complex scenario from a file
gemini run system-scenario-player --input scenario.json
```

## 🔒 Security & Safety
- Inherits all permission requirements from the "muscle" skills.
- Automation can be dangerous if focused on the wrong window; ensure the system is in a stable state before starting.
