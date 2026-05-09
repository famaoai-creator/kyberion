---
title: Kyberion Extension Points
category: Developer
tags: [extension, semver, contract, plugin, actuator]
importance: 10
last_updated: 2026-05-08
---

# Kyberion Extension Points

What is **stable** and what is **internal** in Kyberion. The boundary between "configure / extend" and "fork required".

This is the contract between Kyberion core and:

- 3rd-party / customer authors of actuators, pipelines, plugins, skills.
- FDE engineers running customer engagements who want to know which surfaces they can rely on.
- Core maintainers who must not break stable surfaces without a major version bump.

## 1. Stability Tiers

| Tier | Meaning | Versioning |
|---|---|---|
| **Stable (v1+)** | Public surface. Breaking changes require a major version bump and a migration path. | semver |
| **Beta** | Intentionally exposed but expected to change. Breaking changes allowed in minors with a release note. | semver |
| **Internal** | No stability guarantee. May change in any release. Direct usage discouraged. | none |

## 2. Surfaces

### 2.1 Actuator Contract — **Stable (v1)**

The contract between Kyberion's pipeline engine and an actuator.

**Stable elements** (breaking change requires major bump):

- `manifest.json` schema: keys `actuator_id`, `version`, `capabilities[*].op`, `capabilities[*].platforms`, `contract_schema`.
- The set of `capabilities[*].op` values for a given `actuator_id` (removing an op is breaking).
- The contract schema referenced by `contract_schema`: removing required fields is non-breaking, **adding** required fields is breaking.
- The actuator's CLI entry behavior (stdin/stdout envelope as defined in `runSkill` / `runActuator`).

**Internal elements** (no guarantee):

- The internal directory layout of an actuator (`src/`, helper files).
- The wording of human-readable `description` fields.
- The set of capability `requirements.bin/lib/env` (additive only is non-breaking).
- Internal support helpers like `libs/actuators/meeting-browser-driver/` are implementation details of `meeting-actuator`, not a public extension point.

### 2.2 ADF Pipeline Format — **Stable (v1)**

The JSON format of `pipelines/*.json`.

**Stable elements**:

- Top-level keys: `id`, `name`, `description`, `steps`, `inputs`, `outputs`.
- Step shape: `op` (form: `domain.action`), `params`, `export_as`.
- The `ref` reference resolution (Phase 1 of engine refinement, completed).
- The `on_error` semantics: `skip` / `abort` / `fallback`.

**Beta elements** (may change in minor):

- New step ops added by actuators.
- New top-level fields like `metadata`, `tags`.

**Internal**:

- Internal pipeline-engine state machine.
- The exact format of intermediate context passed between steps.

### 2.3 Plugin Format — **Beta**

The `plugins/` directory format. See [`PLUGIN_AUTHORING.md`](./PLUGIN_AUTHORING.md) for the current authoring guide. Phase D'-1 will lift this to v1.

**Beta**:

- The `package.json` shape for a plugin.
- The plugin manifest fields.

**Internal**:

- The plugin loader implementation.

### 2.4 Skill Format — **Beta**

The `SKILL.md` frontmatter and `runSkill` contract.

**Beta**:

- Frontmatter required fields: `name`, `description`, `status`, `maturity`, `platforms`.
- The `runSkill(name, fn)` / `runAsyncSkill(name, fn)` signatures.

**Internal**:

- The skill wrapper internals.

### 2.5 Knowledge Tier Layout — **Stable (v1)**

The 3-tier directory layout: `knowledge/{personal,confidential,public}/`.

**Stable**:

- Tier names and their purpose (cf. `CLAUDE.md` Rule 5).
- Tier-guard enforcement at `secure-io` boundary.
- Project scoping under `confidential/{project}/`.

**Internal**:

- The internal scanning / indexing strategy.

### 2.6 Customer Aggregation — **Stable (v1) as of 2026-05-07**

See [`CUSTOMER_AGGREGATION.md`](./CUSTOMER_AGGREGATION.md).

**Stable**:

- The `customer/` directory layout and `_template/` schema.
- The `KYBERION_CUSTOMER` env var as the activation mechanism.
- The slug pattern `^[a-z0-9][a-z0-9_-]*$`.
- The resolver API (`activeCustomer`, `customerRoot`, `resolveOverlay`, `overlayCandidates`).
- Resolution order: customer overlay → personal fallback.

### 2.7 Trace Format — **Beta** (will be lifted to v1 after Phase B-1)

`Trace`, `TraceSpan`, `TraceEvent`, `TraceArtifact` types in `libs/core/src/trace.ts`.

**Beta** until Phase B-1 (cross-actuator integration) completes:

- The exact shape of the `Trace` object.
- The OTel-compatible exporter (planned).

### 2.8 CLI — **Stable (v1)**

The set of `pnpm <command>` scripts in `package.json`.

**Stable**:

- Existing top-level scripts: `build`, `test`, `lint`, `typecheck`, `validate`, `doctor`, `mission`, `pipeline`, `cli`, `onboard`, `surfaces:*`, `dashboard`, `control`, `release:notes`.
- Their flags and exit codes.

**Internal**:

- The internal helper scripts under `scripts/`.

## 3. Semver Rules

For each stable surface:

| Change | Bump |
|---|---|
| Remove a feature, field, op, or behavior contract | **major** |
| Add a required field, narrow accepted values | **major** |
| Add an optional feature, field, op | **minor** |
| Add a new actuator | **minor** (of the actuator); core stays the same |
| Doc-only / comment-only / refactor with no observable change | **patch** |
| Performance improvement with no observable change | **patch** |
| Beta → Stable promotion | **minor** of the surface, document in CHANGELOG |

Each actuator carries its own semver in `manifest.json`. The repo as a whole carries `package.json` `version`. Repo version follows the tightest bump across all stable surfaces.

## 4. CI Enforcement

`pnpm check:contract-semver` runs:

1. Computes a **structural fingerprint** for each actuator: `{ actuator_id, sorted ops, contract_schema_hash }`.
2. Compares against `scripts/contract-baseline.json`.
3. Reports:
   - **error** if a fingerprint changed but `version` did not bump (or did not bump enough for the kind of change).
   - **error** if an actuator was removed (without major bump + deprecation note).
   - **warning** for new actuators (must be added to baseline by maintainer).

When intentional, run `pnpm check:contract-semver -- --rebaseline` to update the baseline. This is reviewed in the PR.

## 5. Customer Authoring Guidelines

For FDE / customer engagements:

| Need | Use this | Avoid |
|---|---|---|
| Customer-specific identity / vision | `customer/{slug}/identity.json`, `vision.md` | Editing `knowledge/personal/` when `KYBERION_CUSTOMER` is unset |
| Customer-specific connections | `customer/{slug}/connections/` | Editing `knowledge/personal/connections/` when `KYBERION_CUSTOMER` is unset |
| Customer-specific policy override | `customer/{slug}/policy/` | Editing `knowledge/public/governance/` |
| Customer-specific mission templates | `customer/{slug}/mission-seeds/` | Modifying core `pipelines/` |
| Customer-specific actuator | A new actuator under `libs/actuators/` with its own version | Patching an existing actuator's behavior |
| Customer-specific actuator behavior tweak | A wrapper actuator that calls the core one | Forking the core actuator |

If you find yourself wanting to modify something that isn't listed in §2 as Stable, that's a signal to either:

1. File an issue/PR to lift the surface to Stable, or
2. Use a wrapper / overlay rather than modifying internals.

## 6. Deprecation

Stable surfaces are deprecated for **at least one minor version** before removal:

1. Mark deprecated in code (`@deprecated` JSDoc) and in this document.
2. Emit a runtime warning when used.
3. Remove no earlier than the next major version + minimum 90 days.

## 7. Out of Scope

- **Wire protocols** (HTTP/gRPC over network). Kyberion does not currently expose stable wire protocols externally — Phase D' may introduce them.
- **Plugin marketplace contract**. Phase D'-1 (engine refinement) introduces this and will live by its own semver.
- **A2A protocol**. Currently Beta; will be lifted to v1 after broader inter-agent usage stabilizes.
