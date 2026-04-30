---
title: Python Patterns
category: External-wisdom
tags: [external-wisdom, everything-claude, rules, python, patterns]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Python Patterns

> This file extends [common/patterns.md](knowledge/public/external-wisdom/everything-claude/rules/common/patterns.md) with Python specific content.

## Protocol (Duck Typing)

```python
from typing import Protocol

class Repository(Protocol):
    def find_by_id(self, id: str) -> dict | None: ...
    def save(self, entity: dict) -> dict: ...
```

## Dataclasses as DTOs

```python
from dataclasses import dataclass

@dataclass
class CreateUserRequest:
    name: str
    email: str
    age: int | None = None
```

## Context Managers & Generators

- Use context managers (`with` statement) for resource management
- Use generators for lazy evaluation and memory-efficient iteration

## Reference

See skill: `python-patterns` for comprehensive patterns including decorators, concurrency, and package organization.
