# Standard: Office Open XML (OOXML) for PowerPoint (.pptx)

- **Source**: ECMA-376 / ISO/IEC 29500
- **Context**: Design Distillation & Replication Mission

## 1. Document Structure (Hierarchy)
A `.pptx` file is a ZIP archive with the following core layers:
- **`ppt/slideMasters/`**: The root of the visual identity. Contains background images, logo positions, and default text styles.
- **`ppt/theme/`**: Defines the `clrScheme` (Theme Colors) and `fmtScheme` (Style Matrix).
- **`ppt/slides/`**: Individual slide content referencing Masters and Layouts.

## 2. The Style Matrix (`fmtScheme`)
Instead of defining colors directly, objects often use a reference index:
- **`fillStyleLst`**: Defines 3-level fills (Subtle, Moderate, Intense).
- **`lnStyleLst`**: Defines 3-level line styles.
- **`effectStyleLst`**: Defines effects like shadows or reflections.
- **Problem**: Most high-level libraries (pptxgenjs) only support direct color/line properties, missing these Matrix-based "Quick Styles."

## 3. SmartArt (`ppt/diagrams/`)
SmartArt is not a simple shape. It is a cluster of logic defined by:
- **Data (`data.xml`)**: The structured hierarchy of text and relationships.
- **Layout (`layout.xml`)**: The visual algorithm to arrange shapes.
- **Style (`quickStyle.xml`)**: Advanced MS-specific 3D effects, gradients, and bevels.
- **AI Constraint**: Re-generating SmartArt from scratch using ADF requires a complex rendering engine. 

## 4. Constraint Strategy (Architectural Guardrails)
When replicating PowerPoint via pure text (ADF):
1. **Fidelity Goal**: Aim for 100% Text, Position, and Physical Color (ARGB) accuracy.
2. **Acceptable Distortion**: Master-inherited complex gradients and MS-proprietary SmartArt layouts may be rendered as simplified shapes or flattened images.
3. **The Bypass**: If 100% SmartArt fidelity is required, the "Direct XML Injection" (V5 Pattern) is the only viable path, though it limits dynamic content expansion.

## 5. Implementation Pattern (V15+)
To maximize fidelity, the agent must:
- [x] Resolve `schemeClr` into `srgbClr` (Physical ARGB).
- [x] Synchronize EMU coordinates to Inch scales.
- [ ] Attempt to map `fmtScheme` indices to physical fill/line properties (Best effort).
