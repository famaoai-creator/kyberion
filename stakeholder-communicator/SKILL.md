---
name: stakeholder-communicator
description: >-
  Translates technical decisions and architectural changes into clear,
  business-oriented language for non-technical stakeholders (Execs, Marketing,
  Sales).
status: implemented
arguments:
  - name: input
    short: i
    type: string
    required: true
    description: Path to technical document or JSON report
  - name: audience
    short: a
    type: string
    description: Target audience
  - name: format
    short: f
    type: string
    description: Output format
  - name: out
    short: o
    type: string
    description: Output file path
category: Utilities
last_updated: '2026-02-13'
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
