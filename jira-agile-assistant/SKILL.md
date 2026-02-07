---
name: jira-agile-assistant
description: Automates Jira operations (Cloud/On-prem). Creates issues, updates sprints, and synchronizes the backlog with the technical roadmap.
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
