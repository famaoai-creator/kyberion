---
kind: architecture
scope: repository
authority: reference
phase: execution
owner: runtime_governance
applies_to:
  - slack-bridge
  - chronos-mirror-v2
  - nexus-daemon
  - terminal-bridge
tags:
  - runtime
  - lifecycle
  - surface
  - gateway
---

# Runtime Surface Lifecycle Model

## Purpose

This model defines how long-running human-facing surfaces and supporting bridges are started, supervised, observed, and stopped.

## Categories

1. `gateway`
   External ingress that receives events from a channel or protocol.
   Examples: `slack-bridge`

2. `ui`
   Interactive control surface or workspace application.
   Examples: `chronos-mirror-v2`

3. `service`
   Supporting background bridge or daemon used by runtime routing.
   Examples: `nexus-daemon`, `terminal-bridge`

## Ownership

- `runtime-supervisor` owns the in-process runtime registration.
- `scripts/surface_runtime.ts` owns durable startup and shutdown orchestration.
- `knowledge/public/governance/active-surfaces.json` is the canonical startup manifest.

## Startup Rules

- Background surfaces must be declared in `active-surfaces.json`.
- Each surface must declare:
  - `kind`
  - `command`
  - `args`
  - `cwd`
  - `shutdownPolicy`
  - `startupMode`
- `slack-bridge` and `nexus-daemon` are `background` services.
- `chronos-mirror-v2` is a `workspace-app` and may require a prior build.

## Shutdown Rules

- Detached surfaces are stopped by PID through `surface_runtime.ts stop`.
- In-process state is mirrored into `runtime-supervisor` as `surface:<id>`.
- Surface shutdown must not depend on import-time `process.on()` hooks.

## Operational Commands

```bash
node dist/scripts/surface_runtime.js --action reconcile
node dist/scripts/surface_runtime.js --action status
node dist/scripts/surface_runtime.js --action start --surface slack-bridge
node dist/scripts/surface_runtime.js --action stop --surface chronos-mirror-v2
```

## Boundaries

- Slack ingress belongs to `slack-bridge`, not `service-actuator`.
- Channel delivery belongs to `presence-actuator`.
- Authenticated service access belongs to `service-binding` / `service-actuator`.
- System-local ephemeral commands belong to `system-actuator`.
