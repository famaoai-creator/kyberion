---
name: jira-agile-assistant
description: >-

status: implemented
arguments:
  - name: action
    short: a
    type: string
    required: false
    description:
  - name: input
    short: i
    type: string
    required: false
    description:
  - name: issue-key
    type: string
    required: false
    description:
  - name: dry-run
    type: boolean
    required: false
    description:
category: Connector
last_updated: '2026-02-16'
tags:
  - gemini-skill
---

# Jira Agile Assistant

This skill integrates your project management with your engineering ecosystem.

## Capabilities

### 1. Issue Lifecycle Management

- **Create**: Automatically drafts Jira issues from `requirements-wizard` outputs.
- **Update**: Syncs ticket status when a PR is merged via `gh pr merge`.

### 2. Backlog Grooming

- Analyzes technical debt (via `strategic-roadmap-planner`) and creates prioritized Jira tasks.

## Usage

- "Create a new Jira task for the 'User Auth Fix' and link it to our current sprint."
- "Sync all completed PRs since yesterday with their corresponding Jira tickets."

## Knowledge Protocol

- Adheres to `knowledge/tech-stack/atlassian/jira_best_practices.md`.
