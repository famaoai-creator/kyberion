---
name: trust-fund-monitor
description: Monitors investment trust NAV and info via MUFG Asset Management WebAPI.
status: implemented
main: dist/index.js
category: finance
r: low
tags: gemini-skill,integration,observability
last_updated: '2026-03-02'
---

# Trust Fund Monitor

Tracks the Net Asset Value (NAV) and basic information of investment trusts (e.g., eMAXIS Slim) using the official MUFG Asset Management WebAPI.

## Actions
- `get-nav`: Retrieve the latest Net Asset Value and daily change.
- `list-aliases`: List common fund aliases (e.g., 'オルカン').

## Arguments
- `--code`: Fund code (e.g., `253425`) or alias (e.g., `オルカン`).

## Examples
```bash
# Get NAV for eMAXIS Slim All-Country (using alias)
npm run cli -- run trust-fund-monitor --code "オルカン"

# Get NAV for eMAXIS Slim S&P500
npm run cli -- run trust-fund-monitor --code "s&p500"
```
