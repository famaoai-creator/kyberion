---
title: Browser Actuator v3
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution]
tags: [browser, actuator, playwright, snapshot, ref, testing]
owner: ecosystem_architect
---

# Browser Actuator v3

## Goal

Increase Browser Actuator performance and reliability without changing the core Kyberion concept:

- keep Playwright as the execution engine
- move agent interaction to a `snapshot + ref` contract
- make browser work durable, observable, and exportable into tests

This browser model is also the most natural execution substrate for Kyberion's broader `computer use` concept.

## Core Principle

Browser Actuator v3 separates three layers.

1. **Engine Layer**
   - Playwright remains the physical browser engine
   - owns tabs, locators, tracing, console, network, and auto-wait behavior

2. **Interaction Layer**
   - `snapshot + ref` becomes the agent-facing contract
   - agents do not reason over raw CSS/XPath when a stable ref is available

3. **Export Layer**
   - recorded browser actions can be exported to:
     - ADF
  - browser procedures
  - generated Playwright test skeletons

Above these layers, Kyberion should add a provider-independent **computer interaction loop**:

- observe
- decide
- act
- capture result

See [`computer-use-runtime-model.md`](computer-use-runtime-model.md).

## Why `snapshot + ref`

`selector`-first automation is acceptable for deterministic engineering code, but it is a weak contract for LLM-driven reasoning.

`snapshot + ref` is preferable because it is:

- more stable for agents than raw selectors
- easier to review and replay
- easier to convert into durable workflows and tests
- compatible with multi-tab and approval-driven operation

The browser engine still resolves refs into Playwright locators internally.

## Browser Runtime Model

Browser Actuator v3 should no longer treat each request as:

- launch browser
- perform pipeline
- close browser

That model is too slow and discards state.

Instead, browser work should use a governed session lease model:

- one `browser session`
- one or more tabs
- durable user-data dir
- optional trace/video/network capture
- explicit shutdown or idle timeout

Recommended authority split:

- `browser-runtime-supervisor`
  - session spawn/reuse/stop
- `browser-actuator`
  - interaction, observation, export

This mirrors the existing `agent-runtime-supervisor` pattern.

## Contract Shape

### Snapshot

A snapshot should produce:

- `session_id`
- `tab_id`
- current `url`
- page title
- visible viewport summary
- structured elements with stable refs

Example:

```json
{
  "session_id": "browser-session-1",
  "tab_id": "tab-1",
  "url": "https://example.com/login",
  "title": "Login",
  "elements": [
    {
      "ref": "@e1",
      "role": "textbox",
      "name": "Email",
      "selector": "internal-only",
      "visible": true,
      "editable": true
    },
    {
      "ref": "@e2",
      "role": "button",
      "name": "Sign in",
      "selector": "internal-only",
      "visible": true
    }
  ]
}
```

The selector is internal. Agents should not depend on it.

### Actions

Preferred action set:

- `open_tab`
- `select_tab`
- `snapshot`
- `click_ref`
- `fill_ref`
- `select_ref`
- `press_ref`
- `wait_for_ref`
- `extract_text_ref`
- `capture_console`
- `capture_network`
- `screenshot`

## Multi-Tab Model

Browser-native assistants now gain a lot from tab-aware behavior. Kyberion should support:

- list tabs
- summarize tabs
- compare tabs
- operate on a selected tab set

This is important for:

- research
- dashboards
- SaaS administration flows
- browser-based debugging

## Observe vs Act

Browser Actuator v3 should make observation explicit instead of hiding everything inside action pipelines.

Observation APIs:

- DOM snapshot
- console messages
- network requests
- current URL / title / loading state
- last dialog
- last download

Action APIs:

- click
- fill
- navigation
- keyboard/mouse
- upload/download

This split improves:

- explainability
- debugging
- safety review
- deterministic export

## Approval Model

High-risk actions should not auto-execute just because they are visible in the DOM.

Examples:

- delete
- purchase
- credential submission
- account settings change
- privileged admin operations

Recommended contract:

1. agent proposes a browser action plan
2. risky steps are marked
3. operator or calling mission approves
4. approved steps execute

This is similar to the `ask before acting` pattern in browser-native assistants.

For future runtime convergence, risky browser steps should be representable with the same interaction contract used by higher-level computer-use runtimes.

## Prompt Injection and Site Safety

Browser Actuator v3 must assume the browser is hostile.

Required safeguards:

- hidden page text does not override system instructions
- pasted code / HTML comments / invisible nodes are untrusted
- site allowlist / denylist support
- domain-aware risk classification
- operator approval on sensitive domains or sensitive actions

## Testing Strategy

Future test automation is a first-class goal.

The recommended path is:

1. agent operates in `snapshot + ref`
2. runtime records the action trail
3. trail exports into:
   - ADF
   - browser procedure
   - Playwright test skeleton

That means Playwright remains the execution and final test engine, but the agent does not need to author raw Playwright code during interaction.

## Chronos Integration

Chronos should expose browser sessions as operator-visible resources.

Useful panels:

- browser sessions
- tabs
- recent snapshots
- console stream
- computer interaction sessions and blocked high-risk steps
- network stream
- action trail
- pending approvals

This fits the current control-plane model better than opaque one-shot browser jobs.

## Migration Direction

### Short term

- add `snapshot`
- add stable `ref`
- add `click_ref` / `fill_ref`
- expose console/network observations

### Medium term

- add browser session leases
- add multi-tab summaries
- add action recording and replay
- add export to Playwright test skeleton

### Long term

- add approval-aware browser plans
- add full Chronos browser session operator panel
- add site policy catalog and risk-aware browser automation

## Decision

Kyberion should not replace Playwright.

Kyberion should:

- keep Playwright as the engine
- place `snapshot + ref` above it as the agent contract
- export recorded behavior back into durable Playwright-compatible automation
