---
name: rakuten-travel-connector
description: Searches for hotels and plans on Rakuten Travel.
status: implemented
main: dist/index.js
category: lifestyle
r: low
tags: gemini-skill
last_updated: '2026-03-02'
---

# Rakuten Travel Connector

Accesses the Rakuten Travel API to find hotels and availability.

## Actions
- `search-hotel`: Find hotels by keyword or area.

## Arguments
- `--keyword`: Search term (hotel name, area).
- `--limit`: (Optional) Max results (default: 5).

## Examples
```bash
npm run cli -- run rakuten-travel-connector --keyword "東京駅 ホテル"
```
