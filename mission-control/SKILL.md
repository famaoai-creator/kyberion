---
name: mission-control
description: Orchestrates multiple skills to achieve high-level goals. Acts as the brain of the ecosystem to coordinate complex workflows across the SDLC.
---

# Mission Control (Orchestrator)

This is the "Brain" of the Gemini Skills ecosystem. It knows how to combine 100+ specialized skills to fulfill abstract, high-level requests.

## Capabilities

### 1. Workflow Orchestration
- **Dynamic Workflow Execution**: Refers to patterns in `knowledge/orchestration/` to execute complex multi-step tasks.
- **Key Patterns**:
    - **Hybrid AI-Native Flow**: Optimal balance of TDD for core logic and AI-direct generation for speed. Target 90%+ coverage. See `knowledge/orchestration/hybrid-development-flow.md`.
    - **Advanced Development Flow**: The gold standard for autonomous engineering (Full TDD). See `knowledge/orchestration/advanced-development-flow.md`.
    - **Professional Proposal Pipeline**: See `knowledge/orchestration/proposal-pipeline.md` for the full research-to-production sequence.
    - **Production Readiness Audit**: Coordinates `security-scanner` -> `ux-auditor` -> `license-auditor` -> `project-health-check`.
    - **Enterprise Quality Cycle**: Follows `knowledge/orchestration/quality-management-flow.md` to review, report, and improve artifacts.
    - **Autonomous Troubleshooting**: Links `log-analyst` -> `crisis-manager` -> `self-healing-orchestrator`.

### 2. Executive Reporting
- Summarizes the results of multiple skill executions into a single, high-level status report for stakeholders.

## Usage
- "Execute a full production-readiness audit and report the results."
- "Create a business proposal for [Target Client] regarding [Solution/Technology]."
- "I want to release a new version. Coordinate all necessary checks and documentation."