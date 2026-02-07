---
name: doc-sync-sentinel
description: Automatically synchronizes documentation with code changes. Detects drift between source code and READMEs, Wikis, or comments, and suggests autonomous updates.
---

# Doc-Sync Sentinel

This skill ensures that documentation never becomes stale by keeping it in perfect sync with the implementation.

## Capabilities

### 1. Drift Detection
- Analyzes recent commits and compares them against existing documentation (README, internal docs, JSDoc).
- Identifies specific sections that are no longer accurate due to code changes.

### 2. Autonomous Update
- Generates updated documentation text that reflects the current state of the code.
- Can automatically propose PRs to fix documentation drift.

## Usage
- "Check for documentation drift in the `api/` directory and update the relevant README files."
- "Ensure all JSDoc comments in `src/utils` match the current function signatures."
