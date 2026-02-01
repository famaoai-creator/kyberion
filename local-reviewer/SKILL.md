---
name: local-reviewer
description: Retrieves git diff of staged files for pre-commit AI code review.
---

# Local Reviewer Skill

Retrieves the `git diff` of staged files to allow the AI to perform a code review before committing.

## Usage

```bash
# 1. Stage your changes
git add .

# 2. Run the reviewer
node local-reviewer/scripts/review.cjs
```