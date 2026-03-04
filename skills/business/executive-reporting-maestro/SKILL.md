---
name: executive-reporting-maestro
description: Output file path (JSON or .md)
status: implemented
arguments: 
- name: out
short: o
type: string
required: false
category: Business
last_updated: '2026-02-28'
tags: gemini-skill
---

# Executive Reporting Maestro

This skill translates the complex internal state of the ecosystem into a polished, persuasive report for external audiences.

## Capabilities

### 1. External Status Reporting

- Generates high-level status updates based on `knowledge/pmo/templates/external_status_report.md`.
- Categorizes updates into "Executive Highlights" and "Technical Details."

### 2. Strategic Narrative

- Uses `ppt-artisan` and `stakeholder-communicator` logic to ensure reports focus on business outcomes and risk mitigation.

## Usage

- "Generate a bi-weekly status report for the external PMO team."
- "Create an executive summary of our security posture for the quarterly review."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`.
\n## Governance Alignment\n\n- This skill aligns with **IPA** non-functional standards and **FISC** security guidelines to ensure enterprise-grade compliance.
