---
name: unit-economics-optimizer
description: >-
  Analyzes LTV, CAC, and churn to ensure product profitability. Proposes pricing and customer retention strategies to maximize unit margins.
status: implemented
arguments:
  - name: input
    short: i
    type: string
    required: true
    description: undefined
  - name: out
    short: o
    type: string
    required: false
    description: undefined
category: Business
last_updated: '2026-02-16'
tags:
  - gemini-skill
  - performance
---

# Unit Economics Optimizer

This skill ensures that the company's core business model is fundamentally sound.

## Capabilities

### 1. LTV/CAC Modeling

- Calculates the Lifetime Value (LTV) of customers vs. Acquisition Cost (CAC).
- Compares Research & Development (R&D) and Sales & Marketing (S&M) spending against [IT Cost Benchmarks](../knowledge/economics/it_cost_benchmarks.md).
- Identifies "Unprofitable Segments" that are draining resources.

### 2. Pricing & Churn Strategy

- Proposes pricing adjustments based on `cloud-cost-estimator` data and `telemetry-insight-engine` usage patterns.

## Usage

- "Calculate the unit economics for our 'Basic' plan vs. 'Enterprise' plan."
- "How can we improve our LTV/CAC ratio? Analyze the latest churn data."

## Knowledge Protocol

- Adheres to `knowledge/orchestration/knowledge-protocol.md`.
- References [IT Cost Benchmarks](../knowledge/economics/it_cost_benchmarks.md) for SaaS/Software sector spending standards.
\n## Governance Alignment\n\n- This skill aligns with **IPA** non-functional standards and **FISC** security guidelines to ensure enterprise-grade compliance.
