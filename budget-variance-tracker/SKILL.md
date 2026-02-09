---
name: budget-variance-tracker
description: Compares actual spend and revenue against forecasts. Provides variance analysis and corrective insights to ensure financial discipline.
status: implemented
---

# Budget Variance Tracker

This skill ensures that the CEO's plans stay on track by monitoring the "Actuals."

## Capabilities

### 1. Variance Analysis
- Imports actual financial data and compares it against `financial-modeling-maestro` forecasts.
- Highlights "Negative Variances" (e.g., higher than expected AWS costs) and deviations from [IT Cost Benchmarks](../knowledge/economics/it_cost_benchmarks.md).

### 2. Root Cause Insight
- Connects with `cloud-waste-hunter` and `agent-activity-monitor` to explain *why* costs deviated.

## Usage
- "Perform a month-end variance analysis for the Engineering department."
- "Why are our API costs 20% over budget this month? Provide a breakdown."

## Knowledge Protocol
- Adheres to `knowledge/orchestration/knowledge-protocol.md`.
- References [IT Cost Benchmarks](../knowledge/economics/it_cost_benchmarks.md) for assessing budget health relative to company size and sector.
