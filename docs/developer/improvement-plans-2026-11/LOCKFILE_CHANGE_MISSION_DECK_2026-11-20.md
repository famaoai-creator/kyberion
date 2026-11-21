---
title: Lockfile change review — @presence/mission-deck workspace package
tags: [improvement-plan, 2026-11, lockfile]
last_updated: 2026-11-20
status: completed
---

# Lockfile change review — @presence/mission-deck

- **Date**: 2026-11-20
- **Change**: new workspace package `presence/displays/mission-deck` (`@presence/mission-deck`) and the root `"@presence/mission-deck": "workspace:*"` dependency used by `scripts/deck.ts` (`pnpm deck`).
- **Purpose**: the Mission Deck TUI (conversation, decisions and herdr agents in one Ink screen). See [the package README](../../../presence/displays/mission-deck/README.md).
- **Lockfile diff reviewed**: only importer entries were added (root `link:` to the package, and the package importer). Every resolved version — `ink@7.1.1`, `ink-text-input@6.0.0`, `react@19.3.1`, `ink-testing-library@4.0.0`, `@types/react@19.3.0`, `@types/node@26.6.5`, `typescript@5.9.3` — is already in the tree for `@presence/terminal-hud`. No new package, version, install script or registry source.
- **Lockfile digest**: `pnpm-lock.yaml` sha256: 4d5b008b8fcba913302a67d93691ac4730d3a7ea30bd8534ddecfc4a0649cb95
