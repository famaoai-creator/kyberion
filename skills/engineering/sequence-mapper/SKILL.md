---
name: sequence-mapper
description: 
status: implemented
arguments: 
- name: out
short: o
type: string
required: false
category: Engineering
last_updated: '2026-02-28'
tags: gemini-skill
---

# Sequence Mapper

Generate Mermaid sequence diagrams from source code function calls.

## Usage

node dist/index.js [options]

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
