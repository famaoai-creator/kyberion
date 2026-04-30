---
title: Python Security
category: External-wisdom
tags: [external-wisdom, everything-claude, rules, python, security]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Python Security

> This file extends [common/security.md](knowledge/public/external-wisdom/everything-claude/rules/common/security.md) with Python specific content.

## Secret Management

```python
import os
from dotenv import load_dotenv

load_dotenv()

api_key = os.environ["OPENAI_API_KEY"]  # Raises KeyError if missing
```

## Security Scanning

- Use **bandit** for static security analysis:
  ```bash
  bandit -r src/
  ```

## Reference

See skill: `django-security` for Django-specific security guidelines (if applicable).
