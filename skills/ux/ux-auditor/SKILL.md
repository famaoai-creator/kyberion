---
name: ux-auditor
description: >-

status: implemented
arguments:
  - name: dir
    short: d
    type: string
    required: false
    description:
category: Ux
last_updated: '2026-02-16'
tags:
  - compliance
  - gemini-skill
---

# UX Auditor

This skill acts as a visual consultant to ensure your application is accessible and user-friendly.

## Capabilities

### 1. Visual Heuristics

- Analyzes screenshots (captured via `browser-navigator`) for layout consistency and hierarchy.
- Recommends improvements based on Nielsen Norman Group's usability heuristics.

### 2. Accessibility Check

- Estimates color contrast ratios from visual data.
- Checks for obvious accessibility issues (e.g., missing labels, small touch targets).

## Usage

- "Analyze this screenshot of the login page and provide 3 UX improvement suggestions."
- "Audit the accessibility of the homepage based on current WCAG standards."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
