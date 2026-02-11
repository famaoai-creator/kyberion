---
name: document-generator
description: Unified gateway for all document generation tasks. Automatically routes to specialized artisan skills based on the requested format (PDF, DOCX, XLSX, PPTX, HTML).
status: implemented
arguments:
  - name: input
    short: i
    type: string
    required: true
    description: Input Markdown or JSON file
  - name: format
    short: f
    type: string
    required: true
    choices: [pdf, docx, xlsx, pptx, html]
    description: Desired output format
  - name: out
    short: o
    type: string
    required: true
    description: Output file path
---

# Document Generator (Gateway)

This skill provides a single interface for generating various document types. It coordinates specialized skills like `pdf-composer`, `word-artisan`, etc.

## Usage
- "Generate a PDF report from this markdown file."
- "Convert this JSON data into an Excel spreadsheet."

## Knowledge Protocol
- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`.
