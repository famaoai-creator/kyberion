---
name: schema-inspector
description: Automatically locates and displays schema definition files (SQL, Prisma, OpenAPI, etc.).
status: implemented
category: Engineering
last_updated: '2026-02-28'
tags: gemini-skill,integration
---

# Schema Inspector Skill

Automatically locates and displays the content of schema definition files (SQL, Prisma, OpenAPI, etc.) to help the AI understand data models and APIs.

## Usage

```bash
node dist/index.js <project_root>
```

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
