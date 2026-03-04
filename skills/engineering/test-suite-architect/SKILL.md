---
name: test-suite-architect
description: 
status: implemented
arguments: 
- name: dir
short: d
type: string
required: true
category: Engineering
last_updated: '2026-02-28'
tags: gemini-skill,qa
---

# Test Suite Architect

This skill automates the creation of test implementations, bridging the gap between test planning and execution.

## Capabilities

### 1. Multi-Framework Code Generation

- Generates ready-to-run test files for:
  - **Frontend**: Jest, React Testing Library, Cypress/Playwright.
  - **Backend**: Pytest, Supertest, Mocha/Chai.
- Maps `test-viewpoint-analyst` outputs directly to test cases.

### 2. TDD Orchestration

- Generates failing tests first based on new requirements to guide the implementation phase.

## Usage

- "Generate a Jest test suite for the user authentication logic described in `work/rd.md`."
- "Create Cypress E2E tests based on the TIS functional test viewpoints."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
