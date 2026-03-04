---
name: jpx-market-analyzer
description: Analyzes Japanese stock market data and financials via JPX J-Quants API.
status: implemented
main: dist/index.js
category: finance
r: high
tags: data-engineering,gemini-skill,integration
last_updated: '2026-03-02'
---

# JPX Market Analyzer

Provides deep market intelligence using official Japan Exchange Group (JPX) data.

## Actions
- `get-prices`: Retrieve recent daily OHLCV prices.
- `get-financials`: Retrieve latest financial statements and indicators.

## Arguments
- `--code`: Stock code (e.g., `8697` for JPX, `7203` for Toyota).
- `--action`: (Optional) `get-prices` or `get-financials`.

## Examples
```bash
# Get last 5 days of prices for Toyota
npm run cli -- run jpx-market-analyzer --code 7203

# Get latest financial statements
npm run cli -- run jpx-market-analyzer --action get-financials --code 7203
```
