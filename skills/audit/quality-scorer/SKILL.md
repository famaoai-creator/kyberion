---
name: quality-scorer
description: Output JSON path
status: unstable
arguments: 
- name: out
short: o
type: string
required: false
category: Audit
last_updated: '2026-03-02'
tags: gemini-skill
related_skills:
---

# Quality Scorer

This skill provides a multi-dimensional quality assessment of software projects and documentation.

## Capabilities

### 1. Technical Metrics Audit

- **Waterfall Benchmarks**: Evaluates bug and test densities against the IPA standards defined in `knowledge/quality-management/metrics_standards.md`.
- **Integrity Check**: Flags potential quality risks (e.g., high test density but zero bugs found, suggesting weak test items).

### 2. Textual Analysis

- **Readability & Style**: Scores text based on complexity, length, and adherence to professional standards.

## Usage

```bash
node dist/index.js --input <file_or_dir>
```

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
