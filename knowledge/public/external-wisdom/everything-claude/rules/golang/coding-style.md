---
title: Go Coding Style
category: External-wisdom
tags: [external-wisdom, everything-claude, rules, golang, coding, style]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Go Coding Style

> This file extends [common/coding-style.md](knowledge/public/external-wisdom/everything-claude/rules/common/coding-style.md) with Go specific content.

## Formatting

- **gofmt** and **goimports** are mandatory — no style debates

## Design Principles

- Accept interfaces, return structs
- Keep interfaces small (1-3 methods)

## Error Handling

Always wrap errors with context:

```go
if err != nil {
    return fmt.Errorf("failed to create user: %w", err)
}
```

## Reference

See skill: `golang-patterns` for comprehensive Go idioms and patterns.
