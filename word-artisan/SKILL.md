---
name: word-artisan
description: Generate Word documents (.docx) from Markdown.
status: implemented
---

# Word Artisan

Generate professional, comprehensive Word documents (.docx) from Markdown.

## High-Fidelity Documentation Workflow

When creating complex documents (e.g., NFR Definitions, System Designs):

1.  **Structure Definition**: Align with industry standards (e.g., IPA Non-Functional Requirements Grade).
2.  **Detail-Oriented Writing**: Expand each section with specific technical parameters, configurations, and checklists. Ensure the document provides enough depth for executive and technical review.
3.  **Visual Styling**: Utilize professional styling (fonts like MS Mincho, corporate colors, structured tables) via the conversion engine to ensure the output is boardroom-ready.

## Usage

node word-artisan/scripts/convert.cjs [options]

## Knowledge Protocol
- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
