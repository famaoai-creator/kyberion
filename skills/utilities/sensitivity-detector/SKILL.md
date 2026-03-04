---
name: sensitivity-detector
description: 
status: implemented
arguments: 
- name: input
short: i
type: string
required: true
category: Utilities
last_updated: '2026-02-28'
tags: gemini-skill
related_skills:
---

# Sensitivity Detector

Detect PII and sensitive information in text.

## Usage

node dist/index.js [options]

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
