---
name: auto-context-mapper
description: >-

status: implemented
arguments:
  - name: dir
    short: d
    type: string
    required: false
    description:
  - name: out
    short: o
    type: string
    required: false
    description:
category: Intelligence
last_updated: '2026-02-16'
tags:
  - data-engineering
  - gemini-skill
---

# Auto-Context Mapper

This skill ensures that no task is performed in isolation. It provides "Deep Context" by chaining related data points.

## Capabilities

### 1. Knowledge Chaining

- When a task is started, it identifies related files across `Public`, `Confidential`, and `Personal` tiers.
- Example: If analyzing "AWS Costs," it automatically pulls `kpi_standards.md` and past `budget-variance` reports.

### 2. Prerequisite Gathering

- Automatically prepares the environment by reading necessary design docs or requirements before subsequent skills are triggered by `mission-control`.

## Usage

- "Context-map our current technical debt against the Vision 2030 mission."
- "Prepare the deep context for a multi-year financial simulation."

## Knowledge Protocol

- Adheres to `knowledge/orchestration/knowledge-protocol.md` and `optimization-standards.md`.
