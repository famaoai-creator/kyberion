---
title: TypeScript/JavaScript Hooks
category: External-wisdom
tags: [external-wisdom, everything-claude, rules, typescript, hooks]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# TypeScript/JavaScript Hooks

> This file extends [common/hooks.md](knowledge/public/external-wisdom/everything-claude/rules/common/hooks.md) with TypeScript/JavaScript specific content.

## PostToolUse Hooks

Configure in `~/.claude/settings.json`:

- **Prettier**: Auto-format JS/TS files after edit
- **TypeScript check**: Run `tsc` after editing `.ts`/`.tsx` files
- **console.log warning**: Warn about `console.log` in edited files

## Stop Hooks

- **console.log audit**: Check all modified files for `console.log` before session ends
