---
title: TypeScript/JavaScript Security
category: External-wisdom
tags: [external-wisdom, everything-claude, rules, typescript, security]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# TypeScript/JavaScript Security

> This file extends [common/security.md](knowledge/public/external-wisdom/everything-claude/rules/common/security.md) with TypeScript/JavaScript specific content.

## Secret Management

```typescript
// NEVER: Hardcoded secrets
const apiKey = 'sk-proj-xxxxx';

// ALWAYS: Environment variables
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error('OPENAI_API_KEY not configured');
}
```

## Agent Support

- Use **security-reviewer** skill for comprehensive security audits
