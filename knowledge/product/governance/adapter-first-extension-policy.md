# Adapter-First Extension Policy

**Status**: Beta governance policy

**Audience**: core maintainers, actuator authors, provider/engine integrators,
surface authors, and agents changing Kyberion.

## 1. Purpose

When multiple providers can implement the same capability, Kyberion must keep
the capability contract separate from provider-specific execution. A new
provider that conforms to an existing adapter is an additive registration
change; it must not require edits to every caller, surface, router, or
fallback path.

This policy applies to voice engines, STT/TTS backends, reasoning providers,
actuators, storage providers, browser drivers, and future capability
providers.

## 2. Required architecture

Every multi-provider capability has four distinct layers:

1. **Capability contract** — stable, provider-neutral input/output and error
   semantics. Callers depend on this contract, not on a vendor SDK or engine
   ID.
2. **Adapter contract** — the narrow execution boundary that translates the
   capability contract to one protocol or runtime family. Examples include a
   native host adapter, a governed Python bridge, an OpenAI-compatible server,
   or a CLI adapter.
3. **Provider/engine descriptor** — governance data declaring identity,
   availability, runtime, model, policy, platform, and the adapter ID. It may
   contain configuration and metadata, but not executable provider logic.
4. **Registry and resolver** — discovery, validation, availability probing,
   fallback selection, and adapter resolution. UI and orchestration consume
   resolver output rather than maintaining their own provider list.

The dependency direction is:

```text
surface / orchestrator
        ↓ capability contract
resolver / registry
        ↓ adapter contract
provider or engine implementation
```

The reverse direction is prohibited: an adapter must not make callers know
which provider it is serving.

## 3. Extension decision rule

Before adding a provider, identify the protocol it uses.

| Situation                                                        | Required change                                                                                   | Caller changes                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| New provider uses an existing adapter                            | Add a registry/descriptor entry, runtime declaration, readiness probe, and focused tests          | None in callers, surfaces, or orchestration                                   |
| New provider needs new model/configuration but the same protocol | Extend the descriptor schema with optional fields, then register the provider                     | None; preserve old defaults                                                   |
| New provider uses a genuinely new execution protocol             | Add one adapter implementation and its contract tests                                             | No provider-specific branches; callers continue using the capability contract |
| A provider cannot satisfy the capability contract                | Keep it outside the live capability registry or expose it as an explicit unsupported/shadow entry | Do not weaken the contract for one provider                                   |

Adding a new engine ID is not a reason to add `if (engineId === ...)` to a
caller. Adding a new protocol is not a reason to add vendor branches to every
caller; it is a reason to extend the adapter layer once.

## 4. Rules for implementation

### 4.1 Keep callers provider-neutral

Callers must:

- resolve a descriptor and adapter before execution;
- branch on adapter capabilities or contract outcomes, not provider identity;
- consume normalized errors, readiness, fallback, and telemetry fields;
- preserve the capability contract when an adapter is unavailable.

Callers must not:

- compare provider, vendor, model, or engine IDs to select execution logic;
- import provider SDKs or bridge scripts directly;
- duplicate provider lists in UI, API, CLI, and orchestration code;
- silently fall back to a different provider without exposing the selected
  route and reason.

### 4.2 Keep descriptors declarative

Descriptors may declare:

- stable ID and display name;
- provider and capability kind;
- adapter ID and adapter version;
- runtime/tool ID, model ID, bridge/CLI reference, and platform support;
- readiness requirements, privacy/network class, and fallback ID;
- live/shadow/disabled status and operator-facing notes.

Descriptors must not contain secrets, arbitrary shell fragments, unvalidated
URLs, executable JavaScript, or provider-specific branching instructions.

### 4.3 Make adapter boundaries secure and operationally observable

Each adapter must:

- validate all external paths, URLs, arguments, and environment inputs;
- use the repository secure-I/O and managed-process boundaries;
- fail closed when configuration or capability checks are incomplete;
- expose deterministic readiness and a bounded health probe;
- return normalized success/error results with provider details redacted;
- emit the adapter ID, capability, latency, fallback decision, and reason in
  trace/audit data where the surrounding contract supports it.

Secrets belong in the approved connection or secret store. They must never be
copied into a registry descriptor, UI payload, trace, error, or knowledge
artifact.

### 4.4 Make selection understandable

Selection surfaces must be generated from registry/resolver output. Every
candidate needs:

- human-readable capability/provider name;
- `ready`, `needs_setup`, `unsupported`, or equivalent status;
- a concise reason and required setup action;
- privacy/network information when data leaves the host;
- effective fallback order and the route actually used.

An unavailable provider must be disabled or clearly marked. A hidden fallback
is a UX and operations defect.

## 5. Registration ceremony

An adapter/provider addition is complete only when all applicable items are
done:

1. Define or reuse the capability contract.
2. Select an existing adapter, or add a new adapter with a versioned contract.
3. Add the provider descriptor to the canonical registry and schema.
4. Register required runtime/tool, command, URL, permission, and platform
   requirements through the existing governance registries.
5. Add readiness, fallback, security, and cross-platform tests. Tests must be
   hermetic and must not depend on a developer machine's installed provider.
6. Confirm that UI/API/CLI candidates are resolver-generated and that no
   provider-specific caller branch was introduced.
7. Add or update the operator procedure, privacy note, and troubleshooting
   guidance.
8. Run the matching contract checks, build boundary, focused tests, and
   `pnpm generate:knowledge-index`.

For a new adapter protocol, also document the compatibility and deprecation
plan. An adapter contract change that breaks callers follows the semver rules
in [Kyberion Extension Points](../../../docs/developer/EXTENSION_POINTS.md).

## 6. Review checklist

Reviewers should reject the change until they can answer “yes” to all of the
following:

- Can another provider using the same protocol be added by registration only?
- Is the capability contract independent of provider naming and SDK types?
- Is there exactly one resolver/registry path for discovery and readiness?
- Are fallback and failure reasons visible to operators and users?
- Are secrets, URLs, commands, and paths validated at the adapter boundary?
- Are platform-specific capabilities probe-and-degrade rather than required
  globally?
- Are tests hermetic, cross-platform-aware, and focused on the contract?
- Are existing stable/beta surfaces and semver expectations preserved?

If the answer to the first question is “no”, the implementation is not
adapter-first yet. Refactor the boundary before adding more provider-specific
features.

## 7. Relationship to existing guidance

- [Kyberion Development Practices](./kyberion-development-practices.md) is
  the repository ceremony and verification checklist.
- [Kyberion Extension Points](../../../docs/developer/EXTENSION_POINTS.md)
  defines public stability tiers and semver obligations.
- [Layered Execution Plan](../../../docs/developer/improvement-plans-2026-07/LAYERED_EXECUTION_PLAN_2026-07-15.ja.md)
  defines where declarative wiring, typed logic, and design decisions belong.
- [Voice backend selection procedure](../../public/procedures/media/select-voice-backends.md)
  applies this policy to TTS/STT selection.
