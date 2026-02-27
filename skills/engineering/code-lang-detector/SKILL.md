---
name: code-lang-detector
description: Detect programming language of source code.
status: implemented
arguments:
  - name: input
    short: i
    type: string
    required: false
    description:
category: Engineering
last_updated: '2026-02-16'
tags:
  - gemini-skill
---

# code-lang-detector

Detect programming language of source code.

## Usage

```bash
node code-lang-detector/scripts/detect.cjs --input <file>
```

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
