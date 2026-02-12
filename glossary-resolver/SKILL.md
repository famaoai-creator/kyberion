---
name: glossary-resolver
description: Resolve terms using glossary.
status: implemented
arguments:
  - name: input
    short: i
    type: string
    required: true
  - name: glossary
    short: g
    type: string
    required: true
  - name: out
    short: o
    type: string
---
# glossary-resolver
Resolve terms using glossary.
## Usage
```bash
node glossary-resolver/scripts/resolve.cjs [options]
```

## Knowledge Protocol
- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
