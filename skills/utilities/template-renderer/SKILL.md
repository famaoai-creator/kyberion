---
name: template-renderer
description: 
status: implemented
arguments: 
- name: out
short: o
type: string
required: false
category: Utilities
last_updated: '2026-02-28'
tags: gemini-skill
---

# Template Renderer

Render text from templates (Mustache/EJS) and data.

## Usage

node dist/index.js [options]

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
