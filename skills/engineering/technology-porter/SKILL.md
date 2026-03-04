---
name: technology-porter
description: Output file path
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

# Technology Porter

This skill handles the ultimate technical debt: entire stack migrations.

## Capabilities

### 1. Cross-Language Migration

- Translates core logic between languages (e.g., Python to Rust) while maintaining unit test equivalence.
- Adapts code to the target language's best practices and idioms.

### 2. Equivalency Testing

- Automatically generates comparison tests to ensure the new implementation behaves exactly like the old one.

## Usage

- "Migrate the core processing module from legacy C++ to idiomatic Rust."
- "Port our backend utilities from JavaScript to Go, ensuring all edge cases are preserved."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
