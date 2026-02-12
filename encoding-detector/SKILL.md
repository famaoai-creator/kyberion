---
name: encoding-detector
description: Detect file encoding and line endings.
status: implemented
arguments:
  - name: input
    short: i
    type: string
    required: true
---

# Encoding Detector

Detect file encoding and line endings.

## Usage

node encoding-detector/scripts/detect.cjs [options]

## Knowledge Protocol
- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
