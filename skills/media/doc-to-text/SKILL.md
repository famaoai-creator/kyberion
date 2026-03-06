---
name: doc-to-text
description: Document parsing and extraction engine based on the 3-layer model (Soul, Mask, Context). Supports PDF, Word, Excel, PowerPoint, and OCR.
status: implemented
category: Media
last_updated: '2026-03-06'
tags: ocr,parsing,archaeology
---

# Document to Text Reborn (Digital Archaeologist)

## Overview

This skill utilizes a 3-layer extraction model to "excavate" meaning and aesthetics from various document formats. It separates pure content from design and metadata, enabling high-fidelity analysis and reuse.

## 3-Layer Extraction Model

1. **Content Layer (Soul)**: High-fidelity text extraction maintaining structural elements like headings and tables (Markdown output).
2. **Aesthetic Layer (Mask)**: Extraction of design parameters, colors, fonts, and layout grid information.
3. **Metadata Layer (Context)**: File properties, authorship, and contextual markers.

## Supported Formats

- **PDF**: Text and metadata. (Aesthetic: Coordinate-based analysis)
- **Word (`.docx`)**: Structural Markdown conversion. (Aesthetic: Style extraction)
- **Excel (`.xlsx`)**: Multi-sheet CSV extraction.
- **PowerPoint (`.pptx`)**: Slide-based content extraction.
- **Images**: OCR supporting English and Japanese.

## Usage

```bash
node dist/index.js <file_path> [options]
```

### Options

- `--mode, -m`: Extraction mode. Choices: `content`, `aesthetic`, `metadata`, `all` (default).
- `--out, -o`: Save the structural JSON result to a file.

### Examples

**Extract only text (soul) as Markdown:**
```bash
node dist/index.js report.pdf --mode content
```

**Extract design/layout DNA (mask):**
```bash
node dist/index.js brochure.docx --mode aesthetic
```

## Dependencies

- `pdf-parse`: Basic PDF text.
- `mammoth`: Word-to-Markdown conversion.
- `xlsx`: Excel data parsing.
- `tesseract.js`: Image OCR.
