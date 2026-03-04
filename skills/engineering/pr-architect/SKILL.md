---
name: pr-architect
description: Git repository directory
status: implemented
arguments: 
- name: dir
short: d
type: string
required: false
category: Engineering
last_updated: '2026-02-28'
tags: gemini-skill
---

# PR Architect

This skill automates the creation of professional and informative Pull Requests.

## Capabilities

### 1. Git Workflow Management

- **Branch Strategy**: Suggests descriptive branch names (e.g., `feat/add-login-validation`).
- **Autonomous Delivery**: Executes or suggests `git checkout -b`, `git add`, `git commit`, and `git push` commands to prepare for a PR.

### 2. Narrative Generation

- Explains the purpose of the changes (correlating with requirements).
- Describes the implementation details in a reviewer-friendly way.

### 2. Impact & Verification

- Lists affected modules and potential side effects.
- Includes test results and verification steps automatically.

## Usage

- "Craft a perfect PR description for my staged changes."
- "Analyze these commits and summarize the impact for my next Pull Request."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
