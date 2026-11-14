---
title: Canonical Registry Consolidation — hardcoding audit and single-source decisions
category: Architecture
tags: [registry, catalog, consolidation, storage, tier, tenant, surface, mission]
importance: 8
last_updated: 2026-11-14
runtime_stages: [alignment, execution]
concepts: [tier, tenant, entity-scope, artifact, surface]
---

# Canonical Registry Consolidation (MSN-ABSTRACTION-DEDUP-20261114)

Audit of directly-embedded literals that duplicate an existing governed
registry, and the canonical surface each one was moved to. Rule of thumb this
doc establishes: **a fact that already has a governed registry is declared
there exactly once; code reads the registry, never the literal.**

## Canonical surfaces (the "one place" per fact)

| Fact                         | Single source                                                                                                                                                                                          | Code surface                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Data tiers                   | `foundation/knowledge-tier.ts` `KNOWLEDGE_TIERS` (rank order public→personal)                                                                                                                          | `storage-layout.ts` `STORAGE_DATA_TIERS` (check order personal→public) — never redeclare the literal array         |
| Confidential shared prefixes | `security-policy.json` `tenant_scope.shared_prefixes`                                                                                                                                                  | `governance/shared-scope-prefixes.ts` — owner-segment + prefix helpers                                             |
| Runtime store roots          | `store-catalog.json` (custody/status) → generated `PARTITIONED_*_ROOTS` for partitioned stores; `RUNTIME_STORE_ROOTS` + `RUNTIME_STATE_PATHS` in `runtime-state-roots.ts` for flat legacy-layout roots | `runtimeStatePath(key)` / `RUNTIME_STORE_ROOTS[key]` — never a literal `active/shared/...`                         |
| Surface ports                | surface manifest (`knowledge/product/governance/surfaces/*.json`)                                                                                                                                      | `surface-url.ts` resolvers; fs-free fallbacks drift-guarded by test                                                |
| Env names                    | `env-registry.json` → `config.generated.ts`                                                                                                                                                            | `getRegisteredEnv*`; each (name, default) pair owned by one module                                                 |
| Actuator ops                 | `actuator-op-registry.json` + schema + plugin registration                                                                                                                                             | `actuator-op-registry.ts`                                                                                          |
| Reasoning backends           | provider descriptors + `reasoning-backend-policy.json`                                                                                                                                                 | mode union is a closed vocabulary; new providers ride `provider-cli` / `openai-compatible` adapters, not new modes |
| Mission verbs                | `ACTION_HANDLERS` map in `scripts/refactor/mission-controller-router.ts`                                                                                                                               | new verb = new map entry                                                                                           |

## Findings → resolution

1. **Tier list `['personal','confidential','public']` redeclared ~70×** across
   ~55 files (incl. `z.enum` schemas and same-file duplicates) → all sites
   import `STORAGE_DATA_TIERS` / `KNOWLEDGE_TIERS`;
   `tests/tier-literal-boundary.test.ts` rejects new literals.
2. **`knowledge/confidential/` shared-owner set hardcoded 4× with disagreeing
   values** (`{common,tenant-groups}` vs `{tenant-groups,heuristics,relationships}`)
   → `shared-scope-prefixes.ts` derives the set from
   `tenant_scope.shared_prefixes`; `knowledge/confidential/common/` was added to
   the policy (the directory is shared operations/templates content and three
   modules already treated it as such).
3. **Runtime roots absent from the store catalog** (mesh-hub, feedback-loop,
   presence, delivery-packs, peer-messaging, peer-conversations, a2a,
   role-assumption-trace) → cataloged as `unscoped-legacy` stores with
   `check_store_catalog.baseline.json` bumped 15→23. Retention policies already
   covered every root; the entries give janitor/offboarding/tier tooling a
   governed view. Bare-root runtime-map registration stays blocked by the
   projection's `LEGACY_BARE_LEDGER_REGISTRATIONS` rule — partitioned
   registration is a future `partitionedScopedPath` migration.
4. **Front-desk port fallbacks duplicating the surface manifest** —
   `DEFAULT_FRONT_DESK_PORTS`, `COMPUTER_SURFACE_MIRROR_FALLBACK_PORT` are
   boot-fallback constants (manifest wins at runtime via
   `readFrontDeskSurfacePorts`); a parity test makes drift a failure.
5. **Mission controller 60-case switch** → `ACTION_HANDLERS` map (69 verb
   entries, two shared bodies hoisted to named functions, `default` preserved
   as the unmapped-verb fallback). Case-level `break` became `return`;
   loop-embedded `break` was verified absent before the transform.
6. **Duplicated env(name,default) pairs** (`KYBERION_AGENT_BOOT_READY_TIMEOUT_MS`,
   `KYBERION_RUNTIME_SWEEP_INTERVAL_MS`) → one owning constant each.
7. **`knowledge/confidential/tenants/index.json` declared twice** →
   `TENANT_DESIGN_INDEX_RELATIVE_PATH` exported once from
   `tenant-design-resolver.ts` (consistency.ts imports it; reversed direction
   avoids a new dependency cycle).
8. **`system:exec ls` in `tenant-context-switch.json`** → `file:exists` op.

## Deliberately unchanged (with reasons)

- `console.*` at CLI entry points — eslint-annotated stdout contract; not logging.
- `agent-worktree.ts` `node -e` fs write — deliberate mission-owner write outside the worktree boundary.
- `ReasoningBackendMode` union — closed schema vocabulary; mode≠provider (providers are descriptors).
- `REASONING_PROVIDER_ADAPTERS` — closed protocol set (documented "add id here and in schema").
- `scripts/refactor/` directory name — rename churn outweighs benefit.
- `getProcessEnv` — narrow foundation escape hatch; the governed env surface is `getRegisteredEnv*` (~444 files).
- fs direct imports — governed via `tests/fixtures/governance-import-baseline.json` + boundary test (200-entry allowlist, all explainable).
- Inline `style="--c:..."` custom properties in generated HTML — per-element color tokens, not design-system literals.

## Boundary rules going forward

- A new store root → `store-catalog.json` entry (custody first), then a code
  surface. Never a fresh `active/shared/...` literal in feature code.
- A new shared knowledge prefix → `security-policy.json` `shared_prefixes`,
  then `shared-scope-prefixes.ts` consumers pick it up for free.
- A new tier check → use `STORAGE_DATA_TIERS`/`KNOWLEDGE_TIERS`/`z.enum(KNOWLEDGE_TIERS)`.
- Consistency tests enforce: tier-literal sweep, store-root sweep, front-desk
  port parity.
