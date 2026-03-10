---
title: Standard: Office Open XML (OOXML) for PowerPoint (.pptx)
category: Standards
tags: [standards, media, pptx, ooxml]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---

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
- **Native Engine Solution**: The Native Engine captures the raw `<p:style>` and `<p:spPr>` blocks during extraction, meaning matrix-based "Quick Styles" are preserved with 100% fidelity without needing manual reverse-engineering.

## 3. SmartArt (`ppt/diagrams/`) and Charts (`ppt/charts/`)
SmartArt and Charts are clusters of logic defined by separate internal XML files:
- **Data**: `data.xml` for SmartArt, `chart.xml` + embedded `xlsx` for Charts.
- **Layout**: The visual algorithm to arrange shapes (`layout.xml`).
- **Style/Colors**: Advanced MS-specific 3D effects and gradients (`quickStyle.xml`, `colors.xml`).
- **Native Engine Solution**: The engine natively intercepts `<a:graphicData>` blocks, extracting the raw relational trees and writing them back into the generated archive, maintaining full editability in PowerPoint.

## 4. Constraint Strategy (Architectural Guardrails)
When replicating PowerPoint via pure text (ADF):
1. **Fidelity Goal**: Achieved 100% Text, Position, Physical Color, and Structural accuracy.
2. **Text Typographical Fidelity**: Extracts the raw `<a:pXmlLst>` and `<a:rPr>` (Run Properties), allowing surgical modifications to `bold`, `italic`, or `fontSize` without destroying original Japanese/English typeface selections.
3. **Microsoft Extensions**: Advanced features encoded in `p14` and `p15` namespaces (like custom layout guides or ribbon customizations) are preserved via `<p:extLst>` extraction.

## 5. Implementation Pattern (V19 Native Engine)
To maximize fidelity, the Native Engine MUST:
- [x] Bypass intermediate libraries (`pptxgenjs`).
- [x] Construct `[Content_Types].xml` and `_rels/` layers from scratch natively.
- [x] Extract and re-inject raw OOXML properties (`spPrXml`, `pXmlLst`).
- [x] Ensure slide layouts explicitly set `showMasterSp="0"` when hiding inherited static decorations.
- [x] Rebind Slide Number fields natively (`<a:fld type="slidenum">`).
