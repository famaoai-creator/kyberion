---
category: Fixed
---

- **Every line of a multi-line text shape keeps its paragraph format.** When text contains `\n`, the native PPTX engine now applies `align`, `lineSpacing`, `spaceBefore`, `spaceAfter` and `bullet` to every paragraph it creates. Before, only the first line got them, so line 2 and later of a centered shape were left-aligned.
- **Inherited slide masters no longer trigger PowerPoint's repair prompt.** `pptx_render` now picks `sldMasterId` values that do not collide with the `sldLayoutId` values of inherited masters (`rawMasters` / `rawMasterXml`).
- **`pptx_extract` reads the canvas size of 4:3 decks.** A `<p:sldSz>` that carries extra attributes such as `type="screen4x3"` was not matched, so the canvas width came back as 0. Width and height are now read independently. When `sldSz` is missing, the width defaults to 13.333in (16:9), the same as the height default of 7.5in.
- **Documented units for `cornerRadius` and `lineSpacing`.** `cornerRadius` is a fraction (0–1) or OOXML guide units (above 1), not EMU. `lineSpacing` is a multiplier (10 or less) or a percent (above 10). The section on authoring new slides on an inherited master in `scripts/html-to-pptx/README.md` explains why `rawParts` must be removed.
