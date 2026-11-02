---
title: Declarative Authorization Registry (3-layer model, 4 subject axes)
tags: [governance, authorization, registry, effect-class, approval, plugin]
last_updated: 2026-11-02
---

# Declarative authorization registry

Single source for "which subject needs which authority". Three layers,
merged with a code-always-wins rule:

| layer   | source                                                                                     | trust                              |
| ------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| code    | `libs/core/foundation/authorization-registry.ts`                                           | reviewed with the repo             |
| overlay | `knowledge/product/governance/authorization-registry.json` (customer override: `policy/…`) | governed-catalog, schema-validated |
| plugin  | managed-plugin manifest `authorizations` block                                             | activation-gated, digest-bound     |

## Subject axes (MSN-ADMISSION-UNIFY-20261102)

`subjectAuthorization(subject)` resolves four axes — `operation` (bare id;
exact + prefix), `intent:<id>`, `capability:<id>`, `verb:<id>` (exact keys from
axis bridges). Axis detail layers stay authoritative and are bridged, not
flattened:

| axis       | detail layer                   | resolution                                 |
| ---------- | ------------------------------ | ------------------------------------------ |
| intent     | `approval-policy.json`         | strongest matching rule wins (fail-closed) |
| capability | `grant-capability-policy.json` | capability rule                            |
| verb       | `command-credential-policy.ts` | none / degrading / required → binding      |

Every axis fails toward MORE authority when undeclared: op → external
admission, intent → approval required, capability → tenant binding,
verb → task binding. Empty axis-local ids never match a declaration.

## Declaration attributes beyond authority

- `approvalDomain` — storage partition for approval routing. Call
  `createApprovalRequest`/`admitInternalDecision` with `subject`, never a
  `storageChannel` literal; implicit derivation is ONLY `admission{external}`
  → `external-operation` (other domains need the explicit attribute), and
  undeclared subjects never derive (no silent repartition).
- `protectedPaths` — argument-effect protection; `operation-protection`
  consults the registry before its fallback table.
- `delegable` — DelegationSpec; serializes as `requires_lineage` in the policy
  document (`authorization-policy-document.ts`).
- `actionClass`, `detail` — carried through serialization unchanged.

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
