---
name: budget-variance-tracker
description: >-

status: implemented
arguments:
  - name: input
    short: i
    type: string
    required: true
    description:
  - name: threshold
    short: t
    type: number
    required: false
    description:
  - name: out
    short: o
    type: string
    required: false
    description:
category: Utilities
last_updated: '2026-02-16'
tags:
  - analytics
  - gemini-skill
---

# Budget Variance Tracker

This skill ensures that the CEO's plans stay on track by monitoring the "Actuals."

## Capabilities

### 1. Variance Analysis

- Imports actual financial data and compares it against `financial-modeling-maestro` forecasts.
- Highlights "Negative Variances" (e.g., higher than expected AWS costs) and deviations from [IT Cost Benchmarks](../knowledge/economics/it_cost_benchmarks.md).

### 2. Root Cause Insight

- Connects with `cloud-waste-hunter` and `agent-activity-monitor` to explain _why_ costs deviated.

## Usage

- "Perform a month-end variance analysis for the Engineering department."
- "Why are our API costs 20% over budget this month? Provide a breakdown."

## Knowledge Protocol

- Adheres to `knowledge/orchestration/knowledge-protocol.md`.
- References [IT Cost Benchmarks](../knowledge/economics/it_cost_benchmarks.md) for assessing budget health relative to company size and sector.
