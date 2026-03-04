---
name: local-reviewer
description: Retrieves git diff of staged files for pre-commit AI code review.
status: implemented
category: Engineering
last_updated: '2026-02-28'
tags: gemini-skill
related_skills:
---

# Local Reviewer Skill

Retrieves the `git diff` of staged files to allow the AI to perform a code review before committing.

## Usage

```bash
# 1. Stage your changes
git add .

# 2. Run the reviewer
node dist/index.js
```

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
