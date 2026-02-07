---
name: hive-mind-sync
description: Synchronizes anonymized learning patterns (successful prompts, error fixes) across a federated network of Gemini agents. Enables collective intelligence evolution.
---

# Hive Mind Sync

This skill allows your agent to learn from the experiences of others in your organization.

## Capabilities

### 1. Pattern Export
- Extracts "Success Patterns" from local logs (e.g., "This prompt fixed the bug in one shot").
- Anonymizes sensitive data (Project names, IPs) using `sensitivity-detector`.
- Pushes JSON patterns to a central Git repository (The Hive).

### 2. Wisdom Import
- Pulls new patterns from The Hive.
- Updates local `intent_mapping.yaml` and prompt templates with community-verified best practices.

## Usage
- "Sync my recent learnings with the company Hive."
- "Update my skills with the latest collective wisdom."

## Knowledge Protocol
- Strict Anonymization: Never shares code snippets or secrets, only abstract "Problem -> Solution" patterns.
