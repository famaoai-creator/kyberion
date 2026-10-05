---
title: 'Procedure: Financial Market Analysis (JPX, Trust Funds)'
last_updated: 2026-10-05
---

# Procedure: Financial Market Analysis (JPX, Trust Funds)

## 1. Goal

Fetch and analyze financial market data, including stock prices from JPX and net asset values of trust funds.

## 2. Dependencies

- **Actuator**: `network-actuator` (`pipeline` op with `fetch` / `json_query` / `write_file` steps — secure HTTP fetching)
- **Actuator**: `search-actuator` (`web_search`, `fetch_reader` — discovery and plain-text page reads)
- **Actuator**: `browser-actuator` (scraping fallback when no API/feed exists)
- **Actuator**: `data-actuator` (`query`, `filter`, `join`, `aggregate` — deterministic analysis over local JSON/CSV)
- **Actuator**: `media-actuator` (report rendering)

## 3. Step-by-Step Instructions

1.  **Data Fetching**: Use `network-actuator` `pipeline` with a `fetch` step to retrieve data from public financial APIs, then persist the raw payload under `active/shared/tmp/` (or `active/shared/staging/` for inbound files).
    ```json
    {
      "action": "pipeline",
      "steps": [
        {
          "type": "capture",
          "op": "fetch",
          "params": { "url": "https://quote.jpx.co.jp/...", "method": "GET", "export_as": "quote" }
        },
        {
          "type": "apply",
          "op": "write_file",
          "params": { "path": "active/shared/tmp/market/jpx-quote.json", "from": "quote" }
        }
      ]
    }
    ```
    - For discovery or plain-text reads of a quote/fund page, use `search-actuator` `web_search` / `fetch_reader`. For governed third-party endpoints, check the service presets (`knowledge/product/orchestration/service-presets/`) and reach them via `service-actuator` (`api` / `preset` ops); run `pnpm service:preflight` to verify reachability first.
2.  **Scraping (if API unavailable)**: Use `browser-actuator` to navigate to the fund page and extract the current price into the same JSON/CSV shape as step 1.
3.  **Analysis**: Normalize each fetched payload into a local JSON/CSV table (date, symbol/fund, price/NAV), then run `data-actuator` ops over it:
    - `query` / `filter` to select series and windows.
    - `aggregate` for grouped `count` / `sum` / `avg` / `min` / `max` (period returns, drawdown bounds, volume totals); `join` to align multiple series on a date key.
    - Compute growth rates and variance from the aggregate outputs; for non-deterministic interpretation (risk scoring, alert thresholds, commentary), run a reasoning pass (e.g., `wisdom-actuator` `reasoning` / `peer_advice`) over the computed table — never over raw HTML.
    - Note: `modeling-actuator` is an architecture/ADF transform engine (`ajv_validate`, `json_query`, `mermaid_gen`, `terraform_to_*`, `web_profile_to_*`); it has no financial/statistical models — do not route market analysis through it.
4.  **Reporting**: Render the market summary with `media-actuator` (pptx/pdf/docx/xlsx) or write a Markdown/JSON summary via `write_file` / `write_artifact` as a scoped deliverable.

## 4. Expected Output

A high-fidelity financial report with automated buy/sell or risk alerts.
