---
category: Added
---

- **macOS desktop automation** — the existing pointer and observation APIs now use native CGEvent and Accessibility for mouse actions, generic window titles, focused-control metadata, and logical display size. Permission probes distinguish Accessibility, Screen Recording, System Events and Chrome Automation without prompting. The native helper requires Swift Command Line Tools and reuses a compiled cache; configure macOS Privacy & Security grants for the calling app as needed.
