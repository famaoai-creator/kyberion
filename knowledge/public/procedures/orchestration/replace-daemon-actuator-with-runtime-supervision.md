---
title: Replace Daemon-Actuator With Runtime Supervision
category: Orchestration
tags: [orchestration, runtime, surfaces, process-supervision, cleanup]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-23
---

# Replace Daemon-Actuator With Runtime Supervision

`daemon-actuator` was a launchd-oriented wrapper. It generated plist files and called `launchctl` directly.

That model is now legacy. Kyberion has two explicit runtime ownership models:

- `surface-runtime`
  - for declared long-lived UI, gateway, and service processes
- `process-actuator`
  - for managed processes that need runtime ownership but do not belong in the shared surface manifest

## Migration Mapping

- `register`, `run-once`, `start`, `stop`, `status`, `unregister`
  - move to `knowledge/public/governance/active-surfaces.json` plus `scripts/surface_runtime.ts`
- ad hoc process lifetime management
  - move to `process-actuator`
- `post-msg`, `wait-msg`
  - keep the messaging logic separate from process lifetime management; do not use daemon registration as the transport boundary

## Surface Runtime Pattern

Use [`knowledge/public/governance/active-surfaces.json`](../../governance/active-surfaces.json) as the declaration source, then reconcile with:

```bash
pnpm surfaces:reconcile
```

## Process Ownership Pattern

Use `process-actuator` when you need explicit runtime ownership for a process but do not want it declared as a shared surface.

## Example Migration

The old generation schedule daemon should now be expressed as a surface declaration:

- [`generation-schedule-surface.json`](../../governance/pipelines/generation-schedule-surface.json)

This keeps background process management inside the runtime supervisor instead of handing it off to OS-specific daemon files.
