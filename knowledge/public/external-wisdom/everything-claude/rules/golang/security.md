---
title: Go Security
category: External-wisdom
tags: [external-wisdom, everything-claude, rules, golang, security]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Go Security

> This file extends [common/security.md](knowledge/public/external-wisdom/everything-claude/rules/common/security.md) with Go specific content.

## Secret Management

```go
apiKey := os.Getenv("OPENAI_API_KEY")
if apiKey == "" {
    log.Fatal("OPENAI_API_KEY not configured")
}
```

## Security Scanning

- Use **gosec** for static security analysis:
  ```bash
  gosec ./...
  ```

## Context & Timeouts

Always use `context.Context` for timeout control:

```go
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
```
