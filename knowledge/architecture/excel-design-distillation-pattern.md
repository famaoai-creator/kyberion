# Wisdom: Excel Design Distillation & AI-Native Replication

- **Mission Context**: `excel-design-replication` (v1 - v6)
- **Status**: VERIFIED
- **Core Principle**: "Everything as Structured Text (ADF). Binary templates are legacy distortions."

## 1. The Core Distortion: Theme-Color Mismatch
Excel uses "Theme Colors" (indices like `theme: 9`) which are relative to an internal XML definition (`xl/theme/theme1.xml`).
- **Failure Pattern (v1-v4)**: Copying style indices directly to a new workbook causes "color drift" because the new workbook uses the default Office theme (mapping `theme: 9` to a different color, e.g., Orange instead of Light Green).
- **Inadequate Fix (v3)**: Hardcoding ARGB values for specific cell ranges (e.g., `A3:AL5`). This lacks portability and fails on structural changes.

## 2. The AI-Native Solution: Physical Color Resolution (V6 Pattern)
To maintain visual fidelity without binary templates, the agent must "resolve" abstract themes into absolute physical colors (ARGB) during the distillation phase.

### A. Direct XML Extraction (The Spinal Cord Bypass)
Don't rely solely on high-level library APIs (like `exceljs`) if they don't expose the theme-to-color mapping.
1. **Action**: Access the binary structure (`unzip -p ... xl/theme/theme1.xml`).
2. **Analysis**: Extract the `clrScheme` (Color Scheme) mapping (e.g., `accent6` -> `70AD47`).

### B. Distillation to ADF (The Intelligence Layer)
1. **Transformation**: During analysis, map every theme index to its absolute ARGB value.
2. **Result**: A pure JSON "Design Protocol" (ADF) that contains all physical color information.
   ```json
   {
     "theme_palette": { "9": "FF70AD47" },
     "cells": [ { "address": "A3", "fill": { "argb": "FF70AD47" } } ]
   }
   ```

### C. Pure Reconstruction (The Execution Layer)
1. **Requirement**: Start from a blank workbook (`new Workbook()`).
2. **Action**: Apply styles using only the absolute values from the ADF.
3. **Outcome**: 100% visual fidelity with zero dependency on the original binary template.

## 3. Universal Application
This pattern (Analyze Binary XML -> Resolve to Physical Values -> Structured Protocol -> Pure Re-generation) applies to any complex document format (PowerPoint, Word, PDF) where human-centric formatting must be translated into AI-centric data structures.

## 4. Key Takeaways for Future Missions
- **Portability is King**: If a mission requires the original file to be present for future edits, it is not yet fully "distilled".
- **Validation by Re-generation**: The true test of structural understanding is the ability to recreate the asset from scratch using only the extracted JSON protocol.
- **HTML Bypass**: Converting to HTML is a valid mental shortcut for "rendering-to-absolute-value", but direct XML parsing is the more robust "Sovereign" path.
