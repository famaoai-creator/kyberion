---
name: {{SKILL_NAME}}
description: >-
  Extracts and processes data for {{SKILL_NAME}} purposes.
status: implemented
category: Utilities
last_updated: '{{DATE}}'
freedom_level: med
tags:
  - kyberion-skill
---

# {{SKILL_NAME}}

## Overview

Briefly describes the activity this skill performs in the third person. Avoid using "I" or "this skill can". Focus on what it *does* (e.g., "Generates professional reports from raw metrics").

## Capabilities

- **Capability 1**: Third-person action description (e.g., "Validates schema integrity").
- **Capability 2**: Third-person action description (e.g., "Formats output as JSON").

## Arguments

| Name  | Type   | Description      |
| :---- | :----- | :--------------- |
| --out | string | Output file path |

## Usage

```bash
npm run cli -- run {{SKILL_NAME}} --out result.json
```

## Progressive Disclosure

- **[Detailed Reference](./REFERENCE.md)**: Full API documentation and advanced configuration.
- **[Examples](./EXAMPLES.md)**: Common use cases and input/output samples.
- **[Workflow Guide](./WORKFLOWS.md)**: How to chain this skill with others.

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets.
