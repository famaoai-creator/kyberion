# DOCX Markdown Ingestion Model

This note records the concepts adopted from Markdown-to-DOCX converters and aligns them with Kyberion's existing PPTX/XLSX-native design approach.

## Goal

Keep DOCX generation consistent with other Office render targets:

- parser/input format is separate from rendering
- layout and theme are declarative
- numbering is policy-driven rather than hidden in renderer logic
- native engine consumes a stable protocol, not ad hoc Markdown

## Core Pipeline

The recommended DOCX pipeline is:

1. `source` ingestion
   - markdown / html / text / existing docx
2. normalization into an intermediate document representation
3. numbering and layout enrichment
4. rendering through the native DOCX engine

In Kyberion terms:

- `Markdown -> DocxDesignProtocol`
- `DocxDesignProtocol -> native-docx-engine`

## Adopted Concepts

### 1. Parser / IR / Renderer separation

Markdown parsing should not directly emit WordprocessingML.

Instead:

- parser builds semantic blocks
- layout/numbering enriches those blocks
- renderer only serializes protocol to DOCX

This matches the existing PPTX/XLSX protocol-first design.

### 2. Externalized layout profile

DOCX should carry a declarative `layoutProfile` similar in spirit to PPTX page layouts and XLSX sheet layouts.

Recommended profile groups:

- `fonts`
- `sizes`
- `page`
- `indent`
- `bullet`

These belong in design patterns or document templates, not inside renderer-only code.

### 3. Policy-driven numbering

Heading, figure, and table numbering should be modeled as explicit policy.

Required controls:

- preserve existing heading numbers or regenerate
- heading level numbering format
- sequential vs chapter-based figure numbering
- sequential vs chapter-based table numbering

This is represented as `numberingPolicy`.

### 4. Source-aware document design

`DocxDesignProtocol` should preserve how it was derived.

Examples:

- markdown source body
- html source body
- imported docx path

This becomes `source`, allowing future distillation and round-trip workflows to retain provenance.

## What belongs in the renderer

The native DOCX engine should remain responsible for:

- OpenXML serialization
- styles.xml / numbering.xml emission
- section/page serialization
- relationships/media packaging

It should not become the place where Markdown structure, numbering inference, or layout defaults are invented.

## What belongs outside the renderer

Outside the renderer:

- Markdown parsing
- semantic block normalization
- layout profile resolution from patterns/templates
- numbering policy resolution
- caption generation for figures/tables

## Alignment with PPTX / XLSX

The conceptual mapping is:

- PPTX `page_layouts` -> DOCX `layoutProfile`
- XLSX `sheet_layouts` -> DOCX `layoutProfile`
- PPTX/XLSX declarative design patterns -> DOCX document layout patterns
- native Office engines consume protocol objects, not raw authoring formats

This keeps DOCX in the same family as other governed media surfaces.

## Immediate Follow-ups

1. Add a Markdown-to-`DocxDesignProtocol` compiler.
2. Move current report DOCX defaults toward `layoutProfile` + `numberingPolicy`.
3. Add design patterns for article/report/memo style DOCX outputs.
4. Keep figure/table caption numbering outside the engine core.
