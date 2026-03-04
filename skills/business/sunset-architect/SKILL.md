---
name: sunset-architect
description: Output file path
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

# Sunset Architect

This skill ensures that the codebase stays lean by elegantly removing parts of the system that are no longer valuable.

## Capabilities

### 1. Legacy Identification

- Identifies "Zombie Features" with low utilization and high maintenance/error rates.
- Calculates the cost-savings of removing specific legacy components.

### 2. Graceful Sunsetting

- Generates step-by-step "Retirement Plans" including deprecation warnings, data migration/archiving scripts, and user communication drafts.

## Usage

- "Identify the top 3 candidates for sunsetting in our current codebase."
- "Create a graceful decommissioning plan for the legacy v1 API."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
\n## Governance Alignment\n\n- This skill aligns with **IPA** non-functional standards and **FISC** security guidelines to ensure enterprise-grade compliance.
