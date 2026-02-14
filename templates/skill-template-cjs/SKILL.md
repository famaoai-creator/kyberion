---
name: { { SKILL_NAME } }
description: { { DESCRIPTION } }
status: implemented
arguments:
  - name: input
    short: i
    type: string
    required: true
    description: Input file path
---

# {{SKILL_NAME}}

{{DESCRIPTION}}

## Usage

```bash
node {{SKILL_NAME}}/scripts/main.cjs --input <file>
```

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`.
- It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
- Adheres to the [Sovereign Shield] write governance policy.
