---
title: Computer Use Runtime Model
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution]
tags: [computer-use, browser, actuator, runtime, governance]
owner: ecosystem_architect
---

# Computer Use Runtime Model

This note captures what Kyberion should adopt from "computer use" style systems without copying a provider-specific implementation.

## Core Thesis

Kyberion should treat computer use as:

- a governed runtime loop
- over a sandboxed interaction surface
- using provider-independent action contracts
- with explicit observation, action, and approval boundaries

The concept is broader than browser automation.

It includes:

- browser sessions
- desktop-like surfaces
- text editing and terminal sidecars
- operator-visible replay and approval

## What Kyberion Already Has

Kyberion already contains much of the substrate:

- `browser-actuator` for Playwright execution
- `surface-runtime` for governed long-lived surfaces
- `A2UI` for human-facing live state
- `Chronos` for control and inspection
- approval workflows for risky operations

The missing part is not raw clicking.

The missing part is a first-class **computer interaction loop**.

## The Loop

The canonical loop is:

1. observe the current computer state
2. decide the next interaction
3. execute the interaction
4. capture the result
5. repeat until complete or blocked

Kyberion should represent each step as:

- `observation`
- `action`
- `tool_result`

This is the role of `computer-interaction.schema.json`.

## Separation of Responsibility

### Provider / agent

The model decides:

- whether more observation is needed
- which action is most likely to help
- whether progress is complete

### Runtime / executor

Kyberion executes:

- browser or desktop operations
- screenshot capture
- coordinate normalization
- ref resolution
- trace and replay logging

### Governance layer

Kyberion enforces:

- site and domain risk policy
- approval gates for sensitive actions
- session isolation
- observability and operator review

## Action Vocabulary

The provider-facing contract should stay small and generic.

Preferred families:

- observe
  - `snapshot`
  - `screenshot`
  - `capture_console`
  - `capture_network`
- navigate / focus
  - `open_tab`
  - `select_tab`
- pointer / keyboard
  - `left_click`
  - `double_click`
  - `mouse_move`
  - `drag`
  - `scroll`
  - `type`
  - `key`
  - `wait`
- ref-driven browser actions
  - `click_ref`
  - `fill_ref`
  - `press_ref`
  - `wait_for_ref`
  - `extract_text_ref`

This allows the same contract to work across:

- browser-only environments
- desktop-like environments
- future local-provider loops

## Why This Differs From Raw Browser Pipelines

Current browser automation in Kyberion is strong for deterministic engineering execution.

Computer use adds:

- iterative observe/act loops
- first-class screen state artifacts
- action replay as an operator concept
- approval-aware "ask before acting" on risky UI steps

So the conceptual shift is:

- from pipeline-only execution
- to runtime-mediated interaction loops

## High-Risk Actions

Computer use should never auto-execute certain actions just because the target is visible.

Examples:

- sign in / credential submission
- purchase / payment
- publish / post / send
- delete
- permission grant
- privileged admin settings change

These should be emitted with:

- `risk.level`
- `risk.requires_approval`
- `risk.approval_scope`

The actual approval should flow through the same Kyberion approval model used elsewhere.

## Surface Model

Kyberion should expose computer use through distinct surfaces:

- `command surface`
  - the user asks for a task
- `computer surface`
  - live screen, current step, last observation, risky action prompts
- `control surface`
  - Chronos shows sessions, traces, and blocked/risky steps
- `work surface`
  - drill-down into screenshots, action trails, console, network

## Recommended Near-Term Implementation

1. Keep `browser-actuator` as the physical executor.
2. Add `computer-interaction.schema.json` as the provider-neutral step contract.
3. Create a `computer-surface` runtime that displays:
   - latest screenshot
   - action trail
   - current target
   - approval waits
4. Add `Computer Sessions` to Chronos.
5. Route high-risk actions through approval workflows.

## Design Rule

The key import from computer-use systems is:

- not "LLM clicks things"
- but "LLM proposes interaction steps inside a governed execution loop"

That fits Kyberion's actuator-first and control-surface concepts directly.
