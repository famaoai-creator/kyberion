---
name: land-price-analyzer
description: Analyzes land prices and real estate transactions via MLIT RE-Infolib API.
status: implemented
main: dist/index.js
category: finance
r: high
tags: gemini-skill,integration
last_updated: '2026-03-02'
---

# Land Price Analyzer

Provides professional-grade real estate market analysis using the Ministry of Land, Infrastructure, Transport and Tourism (MLIT) data.

## Actions
- `get-land-price`: Retrieve official land prices (Koji Chika).
- `get-transaction-price`: Retrieve actual real estate transaction prices.

## Arguments
- `--area`: Municipality code (e.g., `13101` for Chiyoda-ku, Tokyo).
- `--year`: (For transactions) Target year (e.g., `2023`).

## Examples
```bash
# Get official land prices for Chiyoda-ku
npm run cli -- run land-price-analyzer --area 13101

# Get actual transaction prices
npm run cli -- run land-price-analyzer --action get-transaction-price --area 13101 --year 2023
```
