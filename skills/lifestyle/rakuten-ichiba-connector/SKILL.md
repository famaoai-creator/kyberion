---
name: rakuten-ichiba-connector
description: Searches for products on Rakuten Ichiba.
status: implemented
category: lifestyle
r: low
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
node scripts/cli.cjs run rakuten-ichiba-connector --keyword "ミネラルウォーター"
```
