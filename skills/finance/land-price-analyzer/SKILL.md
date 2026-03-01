---
name: land-price-analyzer
description: Analyzes land prices and real estate transactions via MLIT RE-Infolib API.
status: implemented
main: scripts/main.cjs
category: finance
r: high
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
node scripts/cli.cjs run land-price-analyzer --area 13101

# Get actual transaction prices
node scripts/cli.cjs run land-price-analyzer --action get-transaction-price --area 13101 --year 2023
```
