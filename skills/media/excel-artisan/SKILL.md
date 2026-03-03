---
name: excel-artisan
description: A specialized artisan for distilling Excel designs into portable ADF (JSON) and re-generating Excel files using these "design patterns" with dynamic data.
status: implemented
category: Media
last_updated: '2026-03-03'
version: '2.0.0'
tags:
  - excel
  - distillation
  - adf
  - automation
---

# Excel Artisan (v2.0)

## Overview

Excel Artisan is no longer a simple spreadsheet writer. It is a **design-centric orchestrator** that bridges the gap between structured data (Markdown, HTML, JSON) and professional Excel aesthetics. By distilling binary Excel files into **Design Protocols (ADF)**, it enables 100% visual fidelity without depending on legacy binary templates.

## Core Capabilities

### 1. Design Distillation (The Distiller)
Extracts the "soul" (visual design) of an existing Excel file into a portable, structured JSON format.
- **Theme Resolution**: Resolves abstract theme colors (e.g., Accent 6) into absolute ARGB values (e.g., #FF70AD47).
- **Structural Mapping**: Captures column widths, row heights, cell merges, and auto-filter ranges.
- **Portable ADF**: Generates a standalone JSON "Pattern" that can recreate the design anywhere.

### 2. Tailored Re-generation (The Tailor)
"Wears" a extracted Design Protocol onto new structured data.
- **Dynamic Hydration**: Maps data (from HTML tables or JSON) onto the template's header and data row styles.
- **Visual Fidelity**: Recreates the exact colors, borders, and fonts of the original design.
- **AI-Native Workflow**: Eliminates binary template dependencies, treating all design as structured text.

## Usage Examples

### Distill: Extract Design from a Source Excel
```bash
excel-artisan --distill vault/downloads/original.xlsx --out knowledge/templates/design/my-pattern.json
```

### Generate: Create Excel from HTML using a Pattern
```bash
excel-artisan --input data.html --template knowledge/templates/design/my-pattern.json --out active/projects/final-report.xlsx
```

## Options

| Option | Alias | Type | Description |
| :--- | :--- | :--- | :--- |
| `--distill` | `-d` | string | Path to source Excel file to extract Design Protocol (ADF). |
| `--template` | `-t` | string | Path to Design Protocol JSON (ADF) to apply as a template. |
| `--input` | `-i` | string | Path to input data (HTML table or JSON array). |
| `--out` | `-o` | string | Output file path (.xlsx for generation, .json for distillation). |
| `--sheet` | | string | Target sheet name for distillation or generation (Default: '本番システム一覧'). |

## Design Philosophy
"Distill the beauty, structure the data, and re-generate the perfection."
By separating **Design (ADF)** from **Data (Markdown/JSON)**, Excel Artisan ensures that professional-grade reports can be generated purely through automated, AI-driven pipelines.
