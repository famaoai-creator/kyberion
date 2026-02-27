---
name: document-generator
description: >-

status: implemented
arguments:
  - name: format
    short: f
    type: string
    required: true
    description:
category: Utilities
last_updated: '2026-02-16'
tags:
  - documentation
  - gemini-skill
---

# Document Generator (Gateway)

This skill provides a single interface for generating various document types. It coordinates specialized skills like `pdf-composer`, `word-artisan`, etc.

## Usage

- "Generate a PDF report from this markdown file."
- "Convert this JSON data into an Excel spreadsheet."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`.
