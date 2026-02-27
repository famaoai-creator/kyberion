---
name: doc-sync-sentinel
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
category: Utilities
last_updated: '2026-02-16'
tags:
  - documentation
  - gemini-skill
---

# Doc-Sync Sentinel

This skill ensures that documentation never becomes stale by keeping it in perfect sync with the implementation.

## Capabilities

### 1. Drift Detection

- Analyzes recent commits and compares them against existing documentation (README, internal docs, JSDoc).
- Identifies specific sections that are no longer accurate due to code changes.

### 2. Autonomous Update

- Generates updated documentation text that reflects the current state of the code.
- Can automatically propose PRs to fix documentation drift.

## Usage

- "Check for documentation drift in the `api/` directory and update the relevant README files."
- "Ensure all JSDoc comments in `src/utils` match the current function signatures."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
