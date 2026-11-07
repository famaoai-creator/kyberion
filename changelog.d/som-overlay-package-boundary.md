---
category: Changed
---

- Move Set-of-Marks overlay rendering from `@agent/core/som-overlay` to
  `@agent/shared-perception/som-overlay`, alongside the perception helpers
  used by the vision actuator. Update direct imports to the new subpath.
- Preserve bitmap glyphs, SVG output, screenshot redaction, secure I/O, and
  temporary-file cleanup, with all nine existing regression cases unchanged.
- Declare the existing Jimp version in shared-perception and its workspace
  dependency in the vision actuator. Transfer one export from core and cover
  the perception package outputs in the workspace build contract.
