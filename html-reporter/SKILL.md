---
name: html-reporter
description: Generate standalone HTML reports from JSON/Markdown.
status: implemented
arguments:
  - name: title
    short: title
    type: string
---

# Html Reporter

Generate standalone HTML reports from JSON/Markdown.

## Usage

node html-reporter/scripts/report.cjs [options]

## Knowledge Protocol
- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
