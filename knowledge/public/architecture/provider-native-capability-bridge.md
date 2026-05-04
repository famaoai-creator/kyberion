# Provider Native Capability Bridge

## Goal

Kyberion should be able to use powerful host- or provider-native execution surfaces without turning them into first-class ADF primitives.

That means:

- keep the core ADF / pipeline contracts provider-neutral
- route special capabilities through governed adapter profiles
- record every host-native or provider-native use in the execution trace
- fall back to Kyberion-local actuators when the native surface is unavailable or too risky

This bridge is especially relevant for:

- Codex app sessions
- Codex computer-use style loops
- provider CLI feature discovery
- browser-interactive host surfaces
- future Gemini-side equivalents

## Design Principle

Do not encode provider-specific mechanics into ADF files.

Instead, split the integration into three layers:

1. capability registry
   - declares what the host or provider can provide
   - in practice, this is driven by `harness-capability-registry.json`
2. adapter registry
   - declares how Kyberion should invoke and observe that surface
   - provider probing is configured separately in `provider-capability-scan-policy.json`
3. execution receipt and trace
   - records what actually happened, including the capability and adapter used

This keeps Kyberion neutral at the core while still allowing strong host-native leverage.

## Why This Is Needed

Some provider-native surfaces are strong enough to justify use:

- `computer_use` is useful for observation-heavy interactive work
- `codex app` style sessions are useful for long-lived conversational or delegated runtime work
- browser-native surfaces are useful for exploratory control

However, if those surfaces are embedded directly into ADF:

- maintenance cost increases
- provider churn leaks into pipeline definitions
- auditability becomes inconsistent
- the same capability has to be re-described in many places

The bridge avoids that by centralizing the contract boundary.

## Contract Boundary

Kyberion should preserve these distinctions:

- `harness-capability-registry`
  - what the host or provider can do
- `harness-adapter-registry`
  - how Kyberion maps a capability to a governed contract
- `agent-runtime-observability`
  - how provider sessions, threads, and refreshes are observed

## TODO: Shared Policy Overrides

`fallback_path`, `fallback_contract`, and `approval_behavior` should eventually be resolved through a shared policy layer rather than being duplicated in every registry entry.

The expected precedence is:

1. capability default
2. provider policy override
3. mission / scenario policy override
4. runtime guard override

For now, the registry values are authoritative. This note exists so the current entries can be treated as seed data, not the final shape of the contract model.

The bridge is complete only when all three are aligned.

## Execution Rule

When Kyberion uses a native surface, the execution receipt should include at least:

- `capability_id`
- `adapter_id`
- `provider`
- `surface_kind`
- `approval_scope`
- `trace_id`
- `runtime_resource_id` or equivalent session reference
- `fallback_path`

For `codex app`, the runtime resource is the provider thread/session tracked by the agent runtime observability model.

For `computer_use`, the runtime resource is the traceable interaction loop and its action trail.

## Routing Rule

Use the native surface when:

- the work is exploratory
- the work is interaction-heavy
- the work benefits from provider-optimized control loops

Use Kyberion-local actuators when:

- the work must be deterministic
- replayability is the primary concern
- the artifact must remain stable across providers
- the host-native surface is unavailable or untrusted

Use dual-path routing when:

- exploration benefits from a native surface
- but the stable outcome must be crystallized into a Kyberion pipeline

## Implementation Summary

The practical implementation is:

1. declare the capability in the harness capability registry when it is host-native
2. declare the adapter profile in the harness adapter registry
3. use the provider runtime observability model for session and thread tracking
4. record the trace and receipt fields consistently
5. fall back to the local actuator or pipeline when the native surface fails

The override policy for fallback and approval remains a TODO until the shared policy layer is added.

For feature discovery, Kyberion should use the governed `discover_capabilities`
and `discover_skills` capture ops, which now include both local actuator
surfaces and verified Codex / GitHub CLI surfaces via the shared
provider capability scanner.

## Gemini Portability

This model is intentionally portable.

Gemini-side implementation should follow the same pattern:

- same separation of capability, adapter, and trace
- different provider runtime details
- same Kyberion governance and fallback rules

That is the main reason to keep the bridge outside ADF itself.
