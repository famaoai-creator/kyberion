---
name: __SKILL_NAME__
description: __DESCRIPTION__
status: planned
arguments:
  - name: input
    short: i
    type: string
    required: true
    description: Input file path
---

# **SKILL_TITLE**

**DESCRIPTION**

## Usage

```bash
npx ts-node __SKILL_NAME__/scripts/main.ts [options]
```

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`.
- It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
- Adheres to the [Sovereign Shield] write governance policy.
