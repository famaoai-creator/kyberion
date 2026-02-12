---
name: code-lang-detector
description: Detect programming language of source code.
status: implemented
arguments:
  - name: input
    short: i
    type: string
---
# code-lang-detector
Detect programming language of source code.
## Usage
```bash
node code-lang-detector/scripts/detect.cjs --input <file>
```

## Knowledge Protocol
- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
