# Codex App Integration Plan

This document outlines how Kyberion should integrate with the Codex App / app-server surface in a governed way.

## Why this is different from Cowork

Cowork is primarily an external collaboration surface that Kyberion can deliver results to.
Codex App is closer to a provider-native execution runtime. That means the integration should focus on:

- discovering which Codex-native capabilities exist on the host
- adapting those capabilities into governed Kyberion contracts
- preserving auditability, approval boundaries, and replayability
- keeping the Codex App path compatible with the existing reasoning-backend and agent-lifecycle model

## Target shape

The integration should follow the same broad flow used for Cowork, but with Codex-specific responsibilities:

1. Detect provider capabilities on the host.
2. Register a governed Codex adapter surface.
3. Route requests through a controlled launch / session model.
4. Surface health, auth, and fallback status in baseline checks.
5. Keep user-visible output and artifact delivery under Kyberion governance.

## Core design principles

- Do not assume the Codex App supports every feature exposed by `codex-cli`.
- Discover capabilities first, then register only the stable subset.
- Treat Codex App session control as a governed runtime, not an implicit side channel.
- Keep file I/O, secrets, and approvals inside Kyberion controls.
- Prefer extensionless package subpaths and public exports that match `@agent/core` package boundaries.

## Proposed architecture

### 1. Capability discovery

Use the existing provider discovery pattern to inspect the local Codex surface:

- `codex --help`
- `codex app-server --help`
- any app-session or MCP-related subcommands exposed by the host

Record the discovered features in governed registries instead of hard-coding assumptions.

Relevant existing references:

- `knowledge/product/architecture/provider-cli-capability-discovery.md`
- `knowledge/product/governance/provider-capability-scan-policy.json`
- `knowledge/product/governance/harness-capability-registry.json`
- `knowledge/product/governance/harness-adapter-registry.json`

### 2. Adapter layer

Add a Codex App adapter that mirrors the existing Codex CLI adapter pattern, but targets the app-native path.

Likely responsibilities:

- spawn / attach to the Codex App runtime when available
- issue structured prompts or tasks through the app session model
- normalize responses into Kyberion agent outputs
- report runtime metadata such as model, session id, and transport mode

This should sit beside the current `CodexAdapter` / `CodexAppServerAdapter` logic rather than replace it.

### 3. Surface registration

Register a dedicated surface manifest for Codex App integration only if the runtime is long-lived and externally observable.

If the Codex App integration is session-scoped instead of daemon-scoped, it may be better represented as:

- a provider capability
- an adapter
- a reasoning backend mode

rather than as a background surface.

### 4. Health and readiness

Add a dedicated health check for:

- availability of the Codex binary
- availability of the app-server / session-control path
- compatibility with the selected backend mode
- required local auth state, if any
- graceful fallback to `codex-cli` or another backend when the app-native path is unavailable

This health signal should feed into the same readiness reporting used by `pnpm doctor` and baseline checks.

### 5. Approval and audit

Any Codex App action that can mutate repo state, create artifacts, or call networked services must still pass through Kyberion approval and audit rails.

That means:

- approvals remain in Kyberion
- generated traces remain in Kyberion
- secrets are not delegated to the app surface directly
- replayable summaries are recorded in `active/` and `knowledge/` as appropriate

## Proposed implementation phases

### Phase 0 - Discovery

Deliverables:

- provider capability scan for Codex App
- documented list of observed commands and modes
- decision on whether the app path is `codex-cli`-compatible or deserves its own mode

### Phase 1 - Adapter

Deliverables:

- Codex App adapter implementation
- structured prompt / response normalization
- fallback to CLI or stub when unavailable

### Phase 2 - Governance wiring

Deliverables:

- service / capability registry entries
- auth and readiness checks
- baseline / doctor integration

### Phase 3 - UX and flow

Deliverables:

- operator-facing flow that mirrors Cowork’s discover -> initialize -> preview -> execute rhythm
- explicit next actions and approval boundaries
- clear distinction between Codex App runtime and plain `codex-cli`

### Phase 4 - Review and distillation

Deliverables:

- tests for the adapter and readiness path
- docs for fallback behavior and supported commands
- distilled hints for future runs

## Expected user flow

The intended user experience should look like this:

1. Kyberion detects Codex App support on the host.
2. Kyberion shows the supported Codex App capabilities.
3. The operator selects the backend or accepts the governed default.
4. Kyberion launches or attaches to the runtime.
5. Requests flow through the governed adapter.
6. Results, approvals, and traces are recorded in the Kyberion lifecycle.

## Open questions

- Is the Codex App path a stable launch target, or only a session-control helper?
- Which commands are safe to treat as provider-native capabilities?
- Should the app path be a new backend mode or a specialization of `codex-cli`?
- What is the minimal health check that avoids false positives on hosts without the Codex App UI?

## Recommendation

Start with discovery and a thin adapter.

Do not introduce a separate Codex App surface until the integration proves it needs one.
Most likely the right abstraction is:

- provider capability discovery
- a governed adapter
- backend mode selection

with surface registration only if the runtime becomes a long-lived managed process.
