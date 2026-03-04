---
name: github-repo-auditor
description: Audits and classifies GitHub repositories into business solutions.
status: implemented
category: Connector
last_updated: '2026-02-28'
tags: compliance,gemini-skill
---

# GitHub Repo Auditor

This skill audits GitHub organizations to map repositories to specific business solutions and monitor maintenance health.

## Capabilities

### 1. Maintenance Auditing

Identifies repositories that have not been pushed to for over a year, flagging them as candidates for archiving.

## Usage

### Run Audit

Execute the audit script to scan the target organization and generate a summary.

```bash
node dist/index.js
```

### View Results

After running the script, read `work/github_audit_report.json` for the full list of repositories per category.

## References

- See [solution_mapping.md](references/solution_mapping.md) for detailed keyword rules and status criteria.

## Knowledge Protocol

- Classified data should be summarized in `knowledge/confidential/governance/github_portfolio.md` for permanent company records.
