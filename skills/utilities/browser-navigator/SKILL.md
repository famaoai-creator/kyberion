---
name: browser-navigator
description: >-
  Automates web interactions using Playwright. Supports both legacy Playwright specs and modern, declarative YAML scenarios with dynamic placeholders and robust frame traversal.
status: implemented
arguments:
  - name: scenario
    short: s
    type: string
    required: true
    description: Path to the .yaml scenario or .spec.js file.
category: Utilities
last_updated: '2026-02-28'
tags:
  - automation
  - browser
  - yaml-driven
  - playwright
---

# Browser Navigator

This skill automates complex web browser workflows. It has been evolved into a **declarative engine** that interprets YAML scenarios, allowing for robust automation without writing custom code.

## 1. YAML Scenario Format

Scenarios are stored as `.yaml` files. They define a sequence of actions to be performed.

```yaml
name: 'Scenario Name'
steps:
  - action: 'goto'
    url: 'https://example.com'
  - action: 'login'
    credentials: 'connection_id' # Refers to knowledge/personal/connections/{id}.json
  - action: 'loop_approve'
    selector: 'a'
    item_filter_keywords: ['{YYYY}/{MM}']
    button: 'Approve'
```

## 2. Available Actions

| Action         | Description                                                     | Parameters                    |
| :------------- | :-------------------------------------------------------------- | :---------------------------- |
| `goto`         | Navigates to a URL.                                             | `url`                         |
| `login`        | Performs login using managed credentials.                       | `credentials` (connection ID) |
| `click_robust` | Clicks an element by text or selector across all frames.        | `text` or `selector`          |
| `loop_approve` | Iterates through a list, opens details, and performs an action. | See below                     |
| `wait`         | Pauses execution.                                               | `timeout` (ms)                |

### `loop_approve` Details

This is a high-level action for processing lists (e.g., approval queues).

- `selector`: Selector for items in the list.
- `item_filter_keywords`: Only process items containing these strings.
- `item_filter_re`: Regex pattern for filtering items.
- `exclude_keywords`: Skip items containing these strings.
- `report_item_template`: Format for the record (e.g., `"### Item: {title}"`).
- `extract_keywords`: Keywords to search for in the detail view to record in the report.
- `button`: The button to click inside the detail view (e.g., "Approve").
- `confirm_buttons`: List of buttons to click after the main action (e.g., ["OK", "Yes"]).

## 3. Dynamic Placeholders

The engine automatically resolves the following placeholders based on the execution date:

- `{YYYY}`: 4-digit year (e.g., 2026)
- `{MM}`: 2-digit month (01-12)
- `{DD}`: 2-digit day (01-31)
- `{YY}`: 2-digit year (26)
- `{M}`, `{D}`: Single-digit month/day where applicable.

## 4. Execution

Run a YAML scenario using the CLI:

```bash
npm run cli -- run browser-navigator --scenario path/to/scenario.yaml
```

## 5. Knowledge Tiering

- **Scenarios**: Should be kept in `knowledge/personal/automation/scenarios/` for private business logic.
- **Credentials**: Managed via `connection-manager` in `knowledge/personal/connections/`.
