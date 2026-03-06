---
name: mouse-injector
description: (Optional) Scroll amount (positive for up, negative for down).
action: inject
arguments: 
- name: scroll
type: number
enum: ["none", "left", "right", "double"]
default: "none"
category: Utilities
tags: gemini-skill
---

# 🖱️ mouse-injector (v1.0)

A high-fidelity muscle skill for the Gemini CLI to perform system-level mouse automation on macOS. It allows the agent to move the pointer, click buttons, drag items, and scroll content.

## 🚀 Capabilities

1.  **Pixel-Precise Movement**: Moves the pointer to any (x, y) coordinate on the screen.
2.  **Multi-Click Support**: Supports left click, right click, and double clicks.
3.  **Drag & Drop**: Can drag the pointer from the current (or specified) position to another.
4.  **Scrolling**: Simulates mouse wheel scrolling for content navigation.

## 📦 Usage Examples

```bash
# Move to (100, 200) and left click
gemini run mouse-injector --x 100 --y 200 --click "left"

# Double click at the current position
gemini run mouse-injector --click "double"

# Scroll down
gemini run mouse-injector --scroll -10
```

## 🔒 Security & Safety
- This skill requires **Accessibility Permissions** in macOS System Settings.
- Be careful with absolute coordinates as screen resolutions vary.
