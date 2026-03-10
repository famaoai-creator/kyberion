---
title: Go Testing
category: External-wisdom
tags: [external-wisdom, everything-claude, rules, golang, testing]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Go Testing

> This file extends [common/testing.md](../common/testing.md) with Go specific content.

## Framework

Use the standard `go test` with **table-driven tests**.

## Race Detection

Always run with the `-race` flag:

```bash
go test -race ./...
```

## Coverage

```bash
go test -cover ./...
```

## Reference

See skill: `golang-testing` for detailed Go testing patterns and helpers.
