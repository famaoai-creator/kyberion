---
name: operational-runbook-generator
description: >-

status: implemented
arguments:
  - name: service
    short: s
    type: string
    required: true
    description:
  - name: type
    short: t
    type: string
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
  - automation
  - gemini-skill
---

# Operational Runbook Generator

This skill ensures that every operational task is documented with professional rigor to prevent human error.

## Capabilities

### 1. Runbook Synthesis

- Translates high-level requests (e.g., "Rotate the DB keys") into a structured Markdown runbook.
- Follows the AI-native guidelines in [Runbook Best Practices](../knowledge/operations/runbook_best_practices.md) (e.g., code blocks, validation steps).

### 2. Risk & Rollback Planning

- Automatically identifies risks associated with the task.
- Generates specific rollback commands for each step as required by the best practices.

## Usage

- "Generate an operational runbook for upgrading our RDS instance from t3.medium to t3.large."
- "Create a procedure for annual SSL certificate rotation."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`.
- References [Runbook Best Practices](../knowledge/operations/runbook_best_practices.md) for generating machine-readable and executable operational procedures.
