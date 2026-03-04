---
name: code-lang-detector
description: 
status: implemented
arguments: 
- name: input
short: i
type: string
required: false
category: Engineering
last_updated: '2026-02-28'
tags: gemini-skill
related_skills:
---

# code-lang-detector

Detect programming language of source code.

## Usage

```bash
node dist/index.js --input <file>
```

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
