---
name: log-analyst
description: Validate JSON log structure
status: implemented
arguments: 
- name: validate
short: n
type: boolean
required: false
category: Utilities
last_updated: '2026-02-28'
tags: gemini-skill
---

# Log Analyst Skill

Reads the tail (end) of a log file to help analyze recent errors or runtime behavior.

## Usage

```bash
node dist/index.js <path_to_log_file> [num_lines]
```

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
