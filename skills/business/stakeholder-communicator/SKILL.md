---
name: stakeholder-communicator
description: >-
  Translates technical decisions and architectural changes into clear, business-oriented language for non-technical stakeholders (Execs, Marketing, Sales).
status: implemented
arguments:
  - name: input
    short: i
    type: string
    required: true
    description: undefined
  - name: audience
    short: a
    type: string
    required: false
    description: undefined
  - name: format
    short: f
    type: string
    required: false
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
---

# Stakeholder Communicator

This skill ensures that engineering value is understood and appreciated by the entire organization.

## Capabilities

### 1. Business Translation & Winning Proposals

- **Strategic Drafting**: Adheres to the `knowledge/strategy/winning-proposal-standards.md` for all business drafts.
- **Value Synthesis**: Translates technical complexity into ROI, "Pain & Gain" narratives, and executive summaries.

### 2. Communication Drafting

- Generates internal announcements, blog posts, or emails regarding system updates and milestones.

## Usage

- "Explain to the CFO why we need a budget for the `Refactoring Engine` migration."
- "Draft a winning proposal for adopting [Technology] based on our current architecture."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
\n## Governance Alignment\n\n- This skill aligns with **IPA** non-functional standards and **FISC** security guidelines to ensure enterprise-grade compliance.
