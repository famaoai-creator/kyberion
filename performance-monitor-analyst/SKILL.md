---
name: performance-monitor-analyst
description: Correlates performance targets with actual profiling results. Identifies bottlenecks and validates against non-functional requirements.
---

# Performance Monitor Analyst

This skill compares "what we want" (NFR) with "what we have" (Profiling Logs).

## Capabilities

### 1. Profiling Log Analysis
- Reads outputs from `Clinic.js`, `cProfile`, or `chrome://tracing`.
- Identifies heavy functions and memory leaks.

### 2. Gap Analysis
- Compares measured response times against the targets in `knowledge/nonfunctional/`.
- Issues "Warning" if targets are missed.

## Usage
- "Analyze this `profile.json` and tell me if we are meeting our 200ms response time requirement."
- "Where is the bottleneck in this Python profile?"
