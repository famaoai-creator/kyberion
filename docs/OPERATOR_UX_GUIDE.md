# Operator UX Guide

Kyberion has a rich internal model, but daily usage should feel simple.
This guide explains:

- where to talk to Kyberion
- how to observe it
- which directories matter to you
- which commands you actually need day to day

Read this after:

- `docs/INITIALIZATION.md`
- `docs/QUICKSTART.md`

## 1. Choose Your Surface

There are three practical ways to interact with Kyberion.

### A. Local terminal or editor chat

Use this when you want:

- fast iteration
- code changes
- direct review of files and tests
- alignment on a technical task

This is the best default surface for development work.

### B. Slack

Use Slack when you want:

- lightweight conversation away from the terminal
- mission proposals from a shared channel or thread
- approvals and confirmations in-thread
- deterministic status delivery back into the original thread

Slack is an ingress and delivery surface.
It is not the mission owner.

Current runtime entrypoint:

- `satellites/slack-bridge/`

Slack connection material belongs in:

- `knowledge/personal/connections/slack.json`

Minimum practical fields:

```json
{
  "bot_token": "xoxb-...",
  "app_token": "xapp-...",
  "default_channel": "#general"
}
```

To start the managed Slack surface:

```bash
pnpm surfaces:reconcile
pnpm surfaces:status
```

The canonical manifest is:

- `knowledge/public/governance/active-surfaces.json`

### C. Chronos Mirror

Use Chronos when you want:

- a local operator dashboard
- mission and runtime visibility
- outbox and delivery visibility
- deterministic control actions
- a live view of agent conversation and A2A handoffs

Chronos is a control surface, not the durable mission authority.
It renders and triggers backend control actions, but mission truth still lives in the control plane.

Local boot:

```bash
export KYBERION_LOCALHOST_AUTOADMIN=true
pnpm chronos:dev
```

Default local URL:

- `http://127.0.0.1:3000`

Access modes:

- `readonly`: inspect only
- `localadmin`: can issue deterministic control actions

## 2. How To Read Chronos

Chronos is easiest to understand as four operator panels.

### A. Mission intelligence

Use this to answer:

- what missions are active
- what just changed
- which mission needs attention next

### B. Agent and runtime health

Use this to answer:

- which managed agents or surfaces are running
- whether runtime leases are healthy
- whether a retry or restart is needed

### C. Surface outbox and delivery

Use this to answer:

- what Slack or other surfaces are about to deliver
- what has already been delivered
- whether a delivery is stuck

### D. Live conversation and delegation

Use this to answer:

- what the current surface conversation is doing
- which delegated responses came back
- how a mission-related exchange evolved over time

If you only remember one rule, remember this:

Chronos explains and intervenes.
It does not replace `mission_controller`, `surface_runtime`, or the runtime supervisor.

## 3. What Lives Where

Most confusion disappears once the main directories are treated by purpose.

| Path | What it is for | You usually put here |
| --- | --- | --- |
| `knowledge/personal/` | Private local configuration | identity, API tokens, private preferences |
| `knowledge/confidential/` | Sensitive organization knowledge | internal standards, private project context |
| `knowledge/public/` | Shared reusable knowledge | procedures, governance, schemas, architecture docs |
| `active/missions/` | Mission-specific runtime state | evidence, checkpoints, coordination, outputs |
| `active/shared/` | Global runtime coordination and observability | logs, outboxes, queues, surface state, tmp artifacts |
| `libs/actuators/` | Physical execution capabilities | browser, file, service, modeling, media, code |
| `scripts/` | Operational entrypoints | mission control, supervisors, onboarding, diagnostics |
| `satellites/` | External channel gateways | Slack bridge and similar integrations |
| `presence/displays/` | Human-facing displays | Chronos Mirror |
| `presence/bridge/` | Shared ingress/runtime bus | stimuli bus and terminal bridge runtime |

Practical placement rules:

- personal secrets go to `knowledge/personal/connections/`
- mission evidence goes to `active/missions/<tier>/<mission_id>/`
- global observability goes to `active/shared/observability/`
- transient generated artifacts go to `active/shared/tmp/`
- reusable knowledge belongs in `knowledge/public/`

## 4. Daily Operator Commands

These are the commands most people actually need.

### Setup and health

```bash
pnpm install
pnpm build
pnpm onboard
pnpm doctor
pnpm capabilities
```

### Surface lifecycle

```bash
pnpm surfaces:reconcile
pnpm surfaces:status
pnpm surfaces:stop
```

### Chronos

```bash
export KYBERION_LOCALHOST_AUTOADMIN=true
pnpm chronos:dev
```

### Capability discovery

```bash
pnpm run cli -- list
pnpm run cli -- search browser
pnpm run cli -- info browser-actuator
```

### Pipeline Management

```bash
# Preview a pipeline without executing (dry-run validation)
pnpm cli preview <pipeline.json>

# Manage scheduled pipelines
pnpm cli schedule list                              # List all scheduled pipelines
pnpm cli schedule register <id> <path> <actuator> "<cron>"  # Register a schedule
pnpm cli schedule remove <id>                       # Remove a schedule

# Check runtime actuator capabilities
pnpm cli list --check                               # Show which actuators are available
```

### Mission lifecycle

```bash
MC="node dist/scripts/mission_controller.js"
$MC help
$MC start MY-TASK confidential
$MC status MY-TASK
$MC checkpoint step-1 "Progress note"
$MC verify MY-TASK verified "Verification summary"
$MC finish MY-TASK
```

## 5. Recommended Usage Patterns

Use the terminal when:

- you are editing code
- you need tests, diffs, or refactors
- you are driving a mission deeply

Use Slack when:

- you want to start or continue a conversation remotely
- you want thread-scoped approvals or confirmations
- you want the response to land back in the same team channel

Use Chronos when:

- you want to inspect what is happening
- you want to see mission and surface state together
- you need to perform a deterministic operator action

## 6. The Smallest Mental Model

If the full architecture is too much, use this model:

1. Talk to Kyberion through terminal, Slack, or Chronos.
2. Missions are the durable unit of work.
3. Actuators are the things that physically do work.
4. `knowledge/` stores governed memory.
5. `active/` stores live runtime state.

That model is enough for most day-to-day operation.

## 7. Related References

- `README.md`
- `docs/QUICKSTART.md`
- `docs/COMPONENT_MAP.md`
- `docs/USER_EXPERIENCE_CONTRACT.md`
- `knowledge/public/architecture/slack-chronos-control-model.md`
- `knowledge/public/connections/setup_guide.md`
