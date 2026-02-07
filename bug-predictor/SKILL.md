---
name: bug-predictor
description: Predicts future bug hotspots by analyzing code complexity, churn, and historical defect patterns. Warns developers before a bug is even written.
---

# Bug Predictor

This skill uses historical data to prevent bugs from being created in the first place.

## Capabilities

### 1. Hotspot Identification
- Analyzes "Churn" (frequently changed files) and "Complexity" to identify files most likely to contain bugs.
- Correlates new changes with past outage patterns.

### 2. Preventive Warning
- Issues a "High Risk" warning during `local-reviewer` or `pr-architect` execution if a change matches a known defect-prone pattern.

## Usage
- "Analyze our recent commits and identify the top 5 bug hotspots."
- "Does this new PR touch any code that has historically caused production outages?"
