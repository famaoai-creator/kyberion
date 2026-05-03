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
   Examples: `slack-bridge`, `imessage-bridge`

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
- `slack-bridge`, `imessage-bridge`, and `nexus-daemon` are `background` services.
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
node dist/scripts/surface_runtime.js --action start --surface imessage-bridge
node dist/scripts/surface_runtime.js --action stop --surface chronos-mirror-v2
```

## Diagnostics Discipline

- Local editor warnings such as `Waited for background terminal` are not canonical proof of a Kyberion runtime leak.
- The canonical runtime view is:
  - `knowledge/public/governance/active-surfaces.json`
  - `active/shared/runtime/surfaces/state.json`
  - `node dist/scripts/surface_runtime.js --action status`
- Residual local `tsx` or CLI processes may come from the terminal host itself and must be distinguished from managed surfaces before taking remediation action.

## Boundaries

- Slack and iMessage ingress belong to their dedicated bridge satellites, not `service-actuator`.
- Channel delivery belongs to `presence-actuator`.
- Authenticated service access belongs to `service-binding` / `service-actuator`.
- System-local ephemeral commands belong to `system-actuator`.
