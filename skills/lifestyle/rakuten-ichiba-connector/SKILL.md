---
name: rakuten-ichiba-connector
description: Searches for products on Rakuten Ichiba.
status: implemented
main: dist/index.js
category: lifestyle
r: low
tags: gemini-skill
last_updated: '2026-03-02'
---

# Rakuten Ichiba Connector

Accesses the Rakuten Ichiba API to find products and prices.

## Actions
- `search-item`: Find items by keyword.

## Arguments
- `--keyword`: Search term.
- `--limit`: (Optional) Max results (default: 5).

## Examples
```bash
npm run cli -- run rakuten-ichiba-connector --keyword "ミネラルウォーター"
```
