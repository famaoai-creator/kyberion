---
name: ppt-artisan
description: A specialized artisan for distilling PPTX designs into portable ADF (JSON) and re-generating presentations, as well as legacy Markdown-to-PPTX conversion.
status: implemented
category: Media
last_updated: '2026-03-03'
version: '2.0.0'
tags:
  - powerpoint
  - distillation
  - adf
  - gemini-skill
---

# PowerPoint Artisan (v2.0)

This skill creates high-impact, boardroom-ready presentations. It has evolved from a simple Markdown-to-Marp converter into a **design-centric orchestrator** that can distill native PPTX designs into portable data and reconstruct them from scratch.

## Core Capabilities (v2.0: AI-Native Generation)

### 1. Design Distillation (The Distiller)
Extracts the "soul" (visual design, heritage chain, physical colors) of an existing PowerPoint file into a portable, structured JSON format.
- **Heritage Sync**: Resolves background images and themes across Slide -> Layout -> Master layers.
- **Physical Color Resolution**: Translates abstract `schemeClr` (e.g., `bg1`, `accent3`) into physical ARGB values.
- **Asset Extraction**: Automatically saves referenced media (images/logos) to an `assets` directory.

### 2. Tailored Re-generation (The Tailor)
"Wears" an extracted Design Protocol onto new presentations without needing the original binary template.
- **Z-Order Preservation**: Ensures backgrounds, master shapes, and text are rendered in the correct optical order.
- **Scale Sync**: Matches the EMU canvas dimensions of the original file perfectly.

## Legacy Capabilities (v1.0: Marp Conversion)
- Converts Markdown files to PPTX using Marp ecosystems.
- Applies custom CSS themes (`--theme`).

## Usage Examples

### Distill: Extract Design from a Source PPTX
```bash
ppt-artisan --distill vault/downloads/original.pptx --out knowledge/templates/design/my-ppt-pattern.json --assets knowledge/templates/design/assets
```

### Generate: Create PPTX from a Pattern
```bash
ppt-artisan --template knowledge/templates/design/my-ppt-pattern.json --out active/projects/final-report.pptx
```

## Options

| Option | Alias | Type | Description |
| :--- | :--- | :--- | :--- |
| `--distill` | `-d` | string | Path to source PPTX file to extract Design Protocol (ADF). |
| `--template` | `-t` | string | Path to Design Protocol JSON (ADF) to apply as a template. |
| `--input` | `-i` | string | Path to input data (Markdown for Marp, or JSON data). |
| `--out` | `-o` | string | Output file path (.pptx for generation, .json for distillation). |
| `--assets` | | string | Directory path to save/load media assets (Default: next to `--out`). |

## Fidelity Modes & Knowledge Protocol
(Legacy Markdown/Marp generation rules regarding Executive/Standard/Deep-Dive modes still apply when using the `--input <markdown>` flow.)

