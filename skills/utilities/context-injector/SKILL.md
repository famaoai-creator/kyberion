---
name: context-injector
description: 
status: unstable
arguments: 
- name: output-tier
short: o
type: string
required: false
category: Utilities
last_updated: '2026-03-02'
tags: gemini-skill
---

# context-injector

Inject knowledge into JSON data context.

## Usage

```bash
node dist/index.js [options]
```

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
