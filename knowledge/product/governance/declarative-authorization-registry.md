---
title: Declarative Authorization Registry (3-layer model)
tags: [governance, authorization, registry, effect-class, approval, plugin]
last_updated: 2026-11-02
---

# Declarative authorization registry

Single source for "which operation needs which authority". Three layers,
merged with a code-always-wins rule:

| layer   | source                                                                                     | trust                              |
| ------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| code    | `libs/core/foundation/authorization-registry.ts`                                           | reviewed with the repo             |
| overlay | `knowledge/product/governance/authorization-registry.json` (customer override: `policy/…`) | governed-catalog, schema-validated |
| plugin  | managed-plugin manifest `authorizations` block                                             | activation-gated, digest-bound     |

## Invariants

- **Code always wins**: an id matching a code declaration ignores all data
  declarations — data adds coverage, never weakens.
- **Data layers cannot bypass**: schema forbids `local_only` and
  `authority.kind:'free'` in overlay/plugin entries; admission-bypass
  requires a reviewed code entry.
- **Boundary ops must be code-declared**: a source-scanning gate requires
  every `operationId` at external-admission call sites to resolve with
  `source === 'code'` — declarations ship in the same PR as the code.
- **exact > prefix** across all data sources regardless of order; longest
  prefix wins; ties go to the earlier source.
- **Provenance**: resolutions carry `source: code | overlay | plugin:<id>`.

## Lessons (MSN-UNIFIED-AUTHZ-20261102)

- Source-scanning gates pay for themselves immediately — the first run
  caught an undeclared `vcs:github:read` and missing delegation metadata.
- Keep heavy subsystem edges **inbound-only**: the plugin layer registers a
  loader into the overlay module rather than the overlay importing plugin
  machinery (module-boundaries SCC ratchet enforced this).
- Fail-open measurement hooks are safe only when the data plane cannot
  grant bypass — pairing warn-only admission with the `free`/`local_only`
  data ban bounds every evasion to fail-closed.
- Cache plugin manifest reads by content digest **and** activation status;
  never cache errors as "no declarations".
