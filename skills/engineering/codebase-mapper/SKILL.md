---
name: codebase-mapper
description: Max tree depth
status: implemented
arguments: 
- name: depth
short: d
type: number
required: false
category: Engineering
last_updated: '2026-02-28'
tags: gemini-skill
related_skills:
---

# Codebase Mapper Skill

Maps the directory structure of the project to help the AI understand the codebase layout.

## Usage

```bash
node dist/index.js <directory_path> [max_depth]
```

- `<directory_path>`: Root directory to map (default: `.`)
- `[max_depth]`: How deep to traverse (default: `3`)

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
