---
name: keyboard-injector
description: (Optional) iTerm2 session ID for targeted injection.
action: inject
arguments: 
- name: sessionId
type: string
default: "iTerm2"
category: Utilities
tags: gemini-skill
---

# 🎹 keyboard-injector (v1.0)

A high-fidelity muscle skill for the Gemini CLI to perform system-level keyboard automation on macOS. It acts as the "fingers" for the agent's brain, capable of typing strings and triggering complex shortcuts within specific applications.

## 🚀 Capabilities

1.  **Human-like Typing**: Types strings with configurable delays to avoid input buffer overflows and bypass anti-bot detections if necessary.
2.  **Special Keys & Shortcuts**: Supports common control keys (Enter, Esc, Tab) and modifier combinations (Ctrl, Cmd, Option, Shift).
3.  **Application Targeting**: Can focus on a specific application before injecting, ensuring input goes to the right place.
4.  **iTerm2 Specifics**: Deep integration with iTerm2 for session-aware routing (compatible with `nexus-daemon`).

## 🛠️ Key Mapping (Standard Keys)

- `enter` (key code 36)
- `tab` (key code 48)
- `esc` (key code 53)
- `space` (key code 49)
- `backspace` (key code 51)
- `up`, `down`, `left`, `right` (arrow keys)

## 📦 Usage Examples

```bash
# Type a command into iTerm2 and press enter
gemini run keyboard-injector --text "npm start" --keys "enter"

# Stop a process with Ctrl+C
gemini run keyboard-injector --keys "control+c"

# Switch apps and perform a shortcut
gemini run keyboard-injector --application "Google Chrome" --keys "command+l"
```

## 🔒 Security & Safety
- This skill requires **Accessibility Permissions** in macOS System Settings for the terminal running the agent.
- Does not log sensitive keystrokes (passwords) unless explicitly requested for debugging (use with caution).
