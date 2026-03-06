---
name: visual-evidence-generator
description: Compiles the 10-frame visual buffer into an animated GIF with timestamp overlays.
action: generate_evidence
arguments: 
- name: output
type: string
description: Path to save the output GIF.
- name: delay
type: number
default: 500
description: Frame delay in milliseconds for the generated GIF.
category: Automation
tags: gemini-skill, vision, audit
---

# 🎞️ visual-evidence-generator (v1.0)

Compiles the system's rolling visual buffer into an animated GIF to serve as an audit trail of automated actions.

## 🚀 Capabilities

1.  **GIF Generation**: Converts the latest captured frames into an animated GIF.
2.  **Overlays**: Automatically overlays the timestamp on each frame using Jimp.
3.  **Configurable Delay**: Allows adjusting the playback speed of the generated evidence.

## 📦 Usage Examples

```bash
gemini run visual-evidence-generator --output evidence.gif --delay 500
```
