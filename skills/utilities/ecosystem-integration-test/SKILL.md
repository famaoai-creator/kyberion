---
name: ecosystem-integration-test
description: >-

status: implemented
arguments:
  - name: dir
    short: d
    type: string
    required: false
    description:
category: Utilities
last_updated: '2026-02-16'
tags:
  - gemini-skill
  - qa
---

# Ecosystem Integration Test

This skill ensures the "Digital Nervous System" is intact.

## Capabilities

### 1. Handover Verification

- Simulates common skill chains (e.g., `RD -> Code`).
- Checks if the JSON output of Skill A matches the input schema of Skill B.

### 2. Protocol Adherence Check

- Verifies that all skills are correctly using `scripts/lib/core.cjs` and following the 3-Tier Knowledge Protocol.

## Usage

- "Run a full integration test on the 'Business Launchpad' meta-skill chain."
- "Verify that `requirements-wizard` outputs can be parsed by `test-suite-architect`."
