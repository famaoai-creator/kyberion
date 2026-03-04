---
name: license-auditor
description: Output path for license report
status: implemented
arguments: 
- name: out
short: o
type: string
required: false
category: Audit
last_updated: '2026-02-28'
tags: compliance,gemini-skill
related_skills:
---

# License Auditor

This skill ensures your project is legally sound by auditing the licenses of all third-party libraries.

## Capabilities

### 1. Compliance Scan

- Lists all licenses found in `package.json`, `requirements.txt`, etc.
- Flags restrictive (copyleft) licenses that might conflict with commercial use.

### 2. Attribution Management

- Automatically generates a `NOTICE` or `THIRD-PARTY-LICENSES` file containing all required legal notices and copyrights.

## Usage

- "Audit the licenses in this project and generate a compliance report."
- "Create a NOTICE file for the upcoming release."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
\n## Governance Alignment\n\n- This skill aligns with **IPA** non-functional standards and **FISC** security guidelines to ensure enterprise-grade compliance.
