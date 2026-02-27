---
name: knowledge-refiner
description: >-

status: implemented
arguments:
  - name: dir
    short: d
    type: string
    required: false
    description:
  - name: action
    short: a
    type: string
    required: false
    description:
  - name: out
    short: o
    type: string
    required: false
    description:
category: Intelligence
last_updated: '2026-02-16'
tags:
  - data-engineering
  - gemini-skill
---

# Knowledge Refiner

This skill keeps the `knowledge/` directory clean and useful.

## Capabilities

### 1. Knowledge Consolidation

- Merges multiple markdown notes into a single structured JSON/YAML glossary.
- Removes duplicate entries and resolves conflicts.

### 2. Pattern Extraction

- Analyzes unstructured text in `work/` or `knowledge/` to extract new reusable patterns for `security-scanner` or `iac-analyzer`.

## Usage

- "Refine the requirements knowledge base by merging all notes into `ipa_best_practices.md`."
- "Extract common error patterns from these logs and save them to `knowledge/security/scan-patterns.yaml`."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
