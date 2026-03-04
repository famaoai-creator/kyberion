---
name: completeness-scorer
description: JSON file with required keywords
status: implemented
arguments: 
- name: criteria
short: c
type: string
required: false
category: Utilities
last_updated: '2026-02-28'
tags: gemini-skill
related_skills:
---

# Completeness Scorer

Evaluate text completeness based on criteria.

## Usage

node dist/index.js [options]

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
