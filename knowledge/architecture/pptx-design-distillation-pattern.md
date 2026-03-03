# Wisdom: PowerPoint Design Distillation & Heritage Sync

- **Mission Context**: `pptx-design-replication` (v1 - v18)
- **Status**: VERIFIED (with known constraints)
- **Core Principle**: "Reconstruct the visual identity through pure XML inheritance, decoupling the design from the binary template."

## 1. The Core Distortion: The Inheritance Chain
Unlike Excel, where cells largely define their own style, PowerPoint operates on a strict **Inheritance Chain (Heritage)**:
`Slide (Content) -> SlideLayout (Grid/Placeholders) -> SlideMaster (Decorations/Logo) -> Theme (Colors/Fonts)`

- **Failure Pattern**: Extracting only the `<p:sp>` (shapes) from the Slide XML results in a "soul-less" replica missing backgrounds, logos, and base colors.
- **The AI-Native Solution**: The distillation process MUST read backwards. If a slide lacks a background, the analyzer must traverse `_rels` to the Layout, and then to the Master, to find the inherited image.

## 2. The Style Matrix (`fmtScheme`) & Aliases
Colors in PowerPoint are rarely defined as absolute ARGB values.
- **Hidden Aliases**: Objects often use `<a:schemeClr val="bg1"/>` or `bg2`. These are aliases for `lt1` (Light 1) and `lt2`, which must be forcibly mapped during theme extraction to prevent them from falling back to black/gray.
- **Matrix Resolution**: Quick Styles reference a matrix index (`<a:fillRef idx="1">`). The analyzer must extract the three-tier `fillStyleLst` from the theme XML and map the index to a physical color before writing the ADF.

## 3. Engineering Constraints & SmartArt
- **Zero-Dimension Connectors**: Straight lines (`<p:cxnSp>`) often have a width or height of `0`. Rendering libraries (like `pptxgenjs`) may ignore these. The generator must forcefully apply a minimum dimension (e.g., `0.01` inches) to ensure visibility.
- **SmartArt Wall**: Complex MS-proprietary logic (`ppt/diagrams/`) cannot be easily mapped to primitive shapes without a dedicated rendering engine. This remains an acceptable distortion boundary for AI-driven text-to-presentation workflows.

## 4. The "Full Heritage" Protocol (V18 Pattern)
The definitive ADF schema for PowerPoint must include:
1. **Canvas**: Exact EMU-to-Inch converted dimensions (e.g., 26.67x15.00).
2. **Master Elements**: Array of shapes/images that appear on every slide.
3. **Slides**: Array of specific objects, with resolved physical colors (`fill`, `line`, `font`) and explicit Z-order preservation.
