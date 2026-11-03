---
title: Seam lifecycle and selection boundary contract
tags: [architecture, seam, provider, lifecycle, refactoring]
last_updated: 2026-11-03
kind: reference
scope: repository
authority: reference
phase: [execution, self_review]
role_affinity: [ecosystem_architect, software_developer]
---

# Seam lifecycle and selection boundary

Use `createSeam` for typed provider registration and `createSeamLifecycle` for
registration ownership and reset. Do not duplicate disposer maps in capability
bridges. Derived router caches must observe additions **and removals**; removing
a provider from the catalog while a cached router can still select it violates
the contract. A previously returned disposer must not remove a replacement.

Builtins use the same registry as extensions. Public provider lists, catalog
snapshots and execution resolution must describe the same registrations. Restore
builtins in the domain composition's reset operation rather than bypassing the
registry inside a getter.

Use `resolveSeamAutoProvider` when an adapter has a domain default and a hard
eligibility filter. Resolve a declared eligible default or the sole eligible
candidate; reject ambiguity rather than assigning priority through ID order.
Capability-restricted providers remain explicit opt-in where required.

Use `resolveSeamSelectionEntry` for the compatibility boundary into governed
provider selection. Explicit choices win before preference processing. A purpose,
a matching operator rule, an opted-in saved default, or an eligible policy
fallback activates `resolveSeamProviderDecision`. An unmatched rule leaves legacy
routing unchanged. These helpers do not authorize provider execution; domain
filters must still enforce egress, language, account, identity and capabilities.

Keep concrete adapters separate from contracts, registries and routers. A public
facade can compose builtins and preserve historical exports; a registry/router
must not import those concrete providers. Shared eligibility checks must serve
both default and purpose-driven routing.

Validate lifecycle and resolution behavior as well as declaration completeness.
Multiplicity and AST checks cannot establish that a removed provider is no longer
selected or that a getter uses the provider visible in its catalog. Cover these
behaviors with hermetic contract and caller regression tests.

See [provider selection](./seam-provider-selection.md) and the
[implementation follow-up](../../../docs/developer/SEAM_LIFECYCLE_CONSOLIDATION_2026-11-03.ja.md).
