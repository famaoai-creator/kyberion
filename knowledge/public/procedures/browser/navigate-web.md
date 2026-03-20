---
title: Procedure: Web Automation & Navigation
tags: [capability, browser, procedure, web-automation, playwright]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-15
kind: capability
scope: global
authority: recipe
phase: [execution]
role_affinity: [software_developer, solution_architect, sovereign_concierge]
applies_to: [browser-actuator, web-automation]
owner: software_developer
status: active
---

# Procedure: Web Automation & Navigation

## 1. Goal
Interact with web applications, extract content, and execute complex browser scenarios using Playwright.

Current direction:

- Playwright remains the execution engine
- agent-facing interaction should move toward `snapshot + ref`
- durable browser automation should be exportable into ADF and Playwright test skeletons

## 2. Dependencies
- **Actuator**: `Browser-Actuator`

## 3. Step-by-Step Instructions
1.  **Simple Extraction**: Use `extract` to retrieve the HTML or text content of a page.
    ```json
    {
      "action": "extract",
      "url": "https://example.com",
      "output_path": "active/shared/tmp/browser/example_content.html"
    }
    ```
2.  **Screenshot**: Use `screenshot` to capture visual evidence of a page's state.
3.  **Snapshot First**: Prefer taking a structured DOM snapshot and operating on stable refs rather than reasoning over raw selectors.
    ```json
    {
      "action": "snapshot",
      "session_id": "browser-session-1"
    }
    ```
4.  **Scenario Execution**: For complex interactions (login, form submission), define a structured scenario array.
    ```json
    {
      "action": "execute_scenario",
      "scenario": [
        { "action": "goto", "url": "https://example.com/login" },
        { "action": "fill_ref", "ref": "@e1", "text": "admin" },
        { "action": "click_ref", "ref": "@e2" }
      ]
    }
    ```

Selector-based steps are still acceptable for deterministic engineering automation, but `snapshot + ref` is the preferred contract for agent-driven interaction.

## 4. Expected Output
State changes within the web application, extracted content, or visual evidence (screenshots).

## 5. Reference
- `knowledge/public/architecture/browser-actuator-v3.md`
