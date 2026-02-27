---
name: bug-predictor
description: >-

status: implemented
arguments:
  - name: dir
    short: d
    type: string
    required: false
    description:
  - name: since
    short: s
    type: string
    required: false
    description:
  - name: top
    short: t
    type: number
    required: false
    description:
  - name: out
    short: o
    type: string
    required: false
    description:
category: Audit
last_updated: '2026-02-16'
tags:
  - gemini-skill
---

# Bug Predictor

This skill uses historical data to prevent bugs from being created in the first place.

## Capabilities

### 1. Hotspot Identification

- Analyzes "Churn" (frequently changed files) and "Complexity" to identify files most likely to contain bugs.
- Correlates new changes with past outage patterns.

### 2. Preventive Warning

- Issues a "High Risk" warning during `local-reviewer` or `pr-architect` execution if a change matches a known defect-prone pattern.

## Usage

- "Analyze our recent commits and identify the top 5 bug hotspots."
- "Does this new PR touch any code that has historically caused production outages?"

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
