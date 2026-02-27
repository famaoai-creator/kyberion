---
name: completeness-scorer
description: Evaluate text completeness based on criteria.
status: implemented
arguments:
  - name: input
    short: i
    type: string
    required: true
    description:
  - name: criteria
    short: c
    type: string
    required: false
    description: undefined
category: Utilities
last_updated: '2026-02-16'
tags:
  - gemini-skill
---

# Completeness Scorer

Evaluate text completeness based on criteria.

## Usage

node completeness-scorer/scripts/score.cjs [options]

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
