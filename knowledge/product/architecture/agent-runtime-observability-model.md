# Agent Runtime Observability Model

## Goal

Provide a consistent control and observability layer for all live agents so the system can:

- inspect current runtime state
- understand recent activity and resource pressure
- refresh context without losing ownership metadata when possible
- restart unhealthy agents deterministically

## Control Layers

1. `agent-lifecycle`
Owns spawn, shutdown, refresh, restart, and per-agent execution metrics.

2. `runtime-supervisor`
Owns resource registration, idle reaping, and process-level ownership metadata.

3. `provider runtime`
Owns provider-native session or thread state.
Examples:
- ACP session ids
- Codex app-server thread ids
- Claude session ids when configured

Provider runtime state is not a host-native capability.
It is the session layer underneath the capability bridge, and it should
always be visible in the trace and execution receipt when a native runtime
is used.

4. `surface / control API`
Exposes snapshots and recovery controls to Chronos Mirror v2 and other operator surfaces.

5. `surface runtime controller`
Owns durable startup, PID tracking, and reconcile semantics for long-running gateways and control surfaces such as Slack Bridge, Chronos Mirror, Nexus Daemon, and Terminal Bridge.

## Snapshot Contract

Each agent snapshot should answer:

- Who is this agent
- What provider/model is it using
- Is it ready, busy, error, or shutdown
- What runtime resource owns it
- What process is behind it, if any
- How many turns it has served
- When it was last active
- Whether soft context refresh is supported
- What recent logs and token usage are available

## Metrics

The lifecycle layer tracks:

- `turnCount`
- `errorCount`
- `restartCount`
- `refreshCount`
- prompt and response character totals
- latest stop reason
- latest provider usage summary when exposed

Provider token usage is best-effort.
If a provider does not emit structured usage, the snapshot still exposes the rest of the runtime state.

## Trace Requirements For Native Surfaces

When Kyberion routes through a host-native capability or provider runtime,
the observability layer should preserve:

- `capability_id`
- `adapter_id`
- `provider`
- `surface_kind`
- session or thread identifier
- approval scope
- fallback path

This is the audit boundary that keeps native leverage compatible with
Kyberion governance.

## Refresh Semantics

There are three refresh modes:

1. `soft`
The provider keeps the process alive but starts a fresh conversational context.
Examples:
- ACP `newSession`
- Codex app-server `thread/start`

2. `stateless`
The provider is already effectively stateless per request, so no special refresh is needed.

3. `restart`
Used when soft refresh is not supported or when the runtime is unhealthy.

## Resilience Rules

- Prefer `soft` refresh before restart when the provider supports it.
- Keep restart deterministic by reusing the stored spawn options.
- Record all restarts and refreshes in lifecycle metrics.
- Join lifecycle metrics with runtime-supervisor state rather than duplicating ownership logic.

## Surface Integration

Chronos Mirror v2 and future operator surfaces should consume:

- `GET /api/agents`
- `POST /api/agents { action: "snapshot" }`
- `POST /api/agents { action: "refresh" }`
- `POST /api/agents { action: "restart" }`

This keeps human control surfaces thin while the lifecycle layer remains the single authority.
