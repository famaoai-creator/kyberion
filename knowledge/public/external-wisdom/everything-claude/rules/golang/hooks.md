---
title: Go Hooks
category: External-wisdom
tags: [external-wisdom, everything-claude, rules, golang, hooks]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Go Hooks

> This file extends [common/hooks.md](knowledge/public/external-wisdom/everything-claude/rules/common/hooks.md) with Go specific content.

## PostToolUse Hooks

Configure in `~/.claude/settings.json`:

- **gofmt/goimports**: Auto-format `.go` files after edit
- **go vet**: Run static analysis after editing `.go` files
- **staticcheck**: Run extended static checks on modified packages
