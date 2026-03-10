---
title: Wisdom: PowerPoint Design Distillation & Heritage Sync
category: Architecture
tags: [architecture, pptx, design, distillation, pattern]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Wisdom: PowerPoint Design Distillation & Heritage Sync

- **Mission Context**: `pptx-design-replication` (v1 - v19)
- **Status**: VERIFIED (100% Fidelity achieved via Native OOXML Engine)
- **Core Principle**: "Reconstruct the visual identity through pure XML inheritance, bypassing intermediate generators to preserve Microsoft-specific extensions and raw OOXML integrity."

## 1. The Core Distortion: The Inheritance Chain
Unlike Excel, where cells largely define their own style, PowerPoint operates on a strict **Inheritance Chain (Heritage)**:
`Slide (Content) -> SlideLayout (Grid/Placeholders) -> SlideMaster (Decorations/Logo) -> Theme (Colors/Fonts)`

- **Failure Pattern**: Extracting only the `<p:sp>` (shapes) from the Slide XML results in a "soul-less" replica missing backgrounds, logos, and base colors. Furthermore, generalized generation libraries (like `pptxgenjs`) fail to respect `showMasterSp="0"` and incorrectly flatten layout placeholders.
- **The AI-Native Solution**: The distillation process MUST read backwards to find inherited images and colors. However, for 100% fidelity, the engine must extract raw XML (`<p:spPr>`, `<a:p>`) and directly inject it back into natively constructed `[Content_Types].xml` and `_rels` files.

## 2. The Style Matrix (`fmtScheme`) & Aliases
Colors in PowerPoint are rarely defined as absolute ARGB values.
- **Hidden Aliases**: Objects often use `<a:schemeClr val="bg1"/>` or `bg2`. These are aliases for `lt1` (Light 1) and `lt2`, which must be forcibly mapped during theme extraction.
- **Perfect Fidelity Strategy**: Rather than attempting to map complex `fmtScheme` indices into generic ADF properties, the extraction process captures the exact `<p:spPr>` and `<p:style>` XML blocks. These raw blocks are injected into the generated PPTX, ensuring gradients, matrix-based fills, and shadows are never lost.

## 3. Engineering Constraints & SmartArt Breakthrough
- **Zero-Dimension Connectors**: Straight lines (`<p:cxnSp>`) are fully preserved via raw `<p:spPr>` injection, eliminating the need to force dimensions.
- **SmartArt & Charts**: Complex MS-proprietary logic (`ppt/diagrams/`, `ppt/charts/`) cannot be safely mapped to generic shapes. The engine extracts the full underlying data sets (`data.xml`, `layout.xml`, embedded Excel `.xlsx`) as base64 or raw string blobs, and accurately resurrects them in the final zip archive via strict `_rels` reconstruction.
- **MS Extensions (p14/p15)**: Modern PPTX features like color-coded slide guides, enhanced transitions, and embedded presence data reside in `<p:extLst>` tags. The native engine transparently extracts and persists these across the generation cycle.

## 4. The "Full Heritage" Protocol (V19 Pattern)
The definitive ADF schema (`PptxDesignProtocol` v3.0.0+) for PowerPoint includes:
1. **Canvas**: Exact EMU-to-Inch converted dimensions (e.g., 26.67x15.00).
2. **Extensions & Theme**: Raw MS extensions (`<p:extLst>`), background XML, and transition settings.
3. **Master Elements**: Arrays of generic and raw elements (`p:grpSp`), clearly segregated between Master static shapes and Layout placeholders.
4. **Slides**: Array of specific objects, heavily utilizing `spPrXml`, `pXmlLst` (to perfectly maintain typography and lists), `smartArtData`, and `chartData` to guarantee 100% visual fidelity without requiring external PPTX templating libraries.
