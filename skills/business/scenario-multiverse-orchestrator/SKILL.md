---
name: scenario-multiverse-orchestrator
description: >-
  Generates multiple business scenarios (Growth/Stability/Hybrid) from financial and strategic assumptions for executive decision-making.
status: implemented
arguments:
  - name: input
    short: i
    type: string
    required: true
    description: undefined
  - name: scenarios
    short: s
    type: number
    required: false
    description: undefined
  - name: out
    short: o
    type: string
    required: false
    description: undefined
category: Business
last_updated: '2026-02-16'
tags:
  - automation
  - gemini-skill
---

# Scenario Multiverse Orchestrator

This skill generates multiple business scenarios for strategic decision-making.

## Capabilities

### 1. Scenario Generation

- Creates Growth, Stability, Pivot, and Exit-Prep scenarios from base assumptions.
- Projects monthly/quarterly financials for each scenario.

### 2. Scenario Comparison

- Identifies highest revenue, longest runway, and lowest risk options.
- Recommends balanced approach based on risk/reward analysis.

## Usage

- "Generate 3 business scenarios for the next 12 months based on our current financials."
- "Compare aggressive growth vs stability for our startup."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`.
\n## Governance Alignment\n\n- This skill aligns with **IPA** non-functional standards and **FISC** security guidelines to ensure enterprise-grade compliance.
