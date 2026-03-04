---
name: sovereign-sync
description: Syncs specific knowledge tiers with external private repositories.
status: implemented
category: Intelligence
last_updated: '2026-02-28'
tags: gemini-skill
---

# Sovereign Sync

This skill enables the **External Knowledge Link** pattern. It allows specific tiers of the Sovereign Matrix (like L3 Confidential) to be managed as independent Git repositories, separate from the monorepo logic.

## Capabilities

### 1. Initialize Link

Link a knowledge tier to an external private repository.

- **Command**: \`node dist/index.js init <tier> <repo_url>\`

### 2. Import (Pull)

Fetch the latest maps, entity definitions, and shared analysis from the organization.

- **Command**: \`node dist/index.js pull <tier>\`

### 3. Share (Push)

Push local analysis results and updated mappings to the private organizational repository.

- **Command**: \`node dist/index.js push <tier>\`

## Default Configuration

- **L3 (Confidential)**: Intended to be synced with the organization's Private Engineering Repo.
- **L2 (Roles)**: Can optionally be synced with a restricted Executive Repo.

## Knowledge Protocol

- This skill MUST NOT be used on the \`public\` tier.
- It facilitates the "Sovereign Knowledge Sharing" required for multi-entity orchestration.
