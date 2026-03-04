---
name: self-evolution
description: Analyzes project history and failures to self-propose improvements to GEMINI.md or skill scripts.
status: implemented
category: Core
last_updated: '2026-02-28'
arguments: 
- name: reason
short: r
type: string
required: true
tags: gemini-skill
---

# self-evolution

## Capabilities

- **Incident Analysis**: Reads `knowledge/incidents/` to identify recurring patterns.
- **Auto-Backup**: Creates `.bak` files in `active/archive/backups/` before any changes.
- **Draft Refinement**: Proposes instruction updates via a new Git branch and PR.

## Arguments

| Name     | Type   | Description                                         |
| :------- | :----- | :-------------------------------------------------- |
| --target | string | (Optional) File to refine. Defaults to 'GEMINI.md'. |
| --reason | string | (Required) Reason for the self-correction.          |

## Usage

```bash
npm run cli -- run self-evolution --target GEMINI.md --reason "Simplify bootstrap instructions"
```
