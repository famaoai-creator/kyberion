---
title: Kyberion Extension Points
category: Developer
tags: [extension, semver, contract, plugin, actuator]
importance: 10
last_updated: 2026-08-17
---

# Kyberion Extension Points

What is **stable** and what is **internal** in Kyberion. The boundary between "configure / extend" and "fork required".

This is the contract between Kyberion core and:

- 3rd-party / customer authors of actuators, pipelines, plugins, skills.
- FDE engineers running customer engagements who want to know which surfaces they can rely on.
- Core maintainers who must not break stable surfaces without a major version bump.

## 1. Stability Tiers

| Tier             | Meaning                                                                                               | Versioning |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| **Stable (v1+)** | Public surface. Breaking changes require a major version bump and a migration path.                   | semver     |
| **Beta**         | Intentionally exposed but expected to change. Breaking changes allowed in minors with a release note. | semver     |
| **Internal**     | No stability guarantee. May change in any release. Direct usage discouraged.                          | none       |

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
- Shared utility functions such as `slugify`, `retry`, `chunk`, `sleep`, `loadJson`, and `ensureDir` should be imported from `@agent/core` rather than redefined locally.

### 2.2 ADF Pipeline Format — **Stable (v1)**

The JSON format of `pipelines/*.json`.

**Stable elements**:

- Top-level keys are governed by `knowledge/product/schemas/pipeline-adf.schema.json`; the current stable core is `action`, `name`, `description`, `context`, `knowledge_scope`, `env`, `options`, `steps`, and `schedule`.
- Step shape: `op` (canonical form `domain:action`), optional typed `role`, `params`, `produces`/`consumes`, `depends_on`, `on_error`, `reasoning`, `facets`, and `report`.
- `reasoning` declares step-level provider/profile/model/permission intent. Resolution remains governed by the reasoning route policy and provider capability gate; a pipeline cannot grant a permission below the policy floor.
- `facets` composes `persona`, `policies`, `instructions`, and `output_contract` by name. Resolution is tenant → product → approved managed pack → legacy/builtin, and a public pipeline cannot read a confidential tenant facet.
- `report` declares a post-perform report phase. It may be a single contract or an ordered list; each report is validated against a registered structured contract or a JSON Schema under `knowledge/product/schemas/` before being exported to the next step.
- Provider runtime instructions are additive prompt material resolved by the selected reasoning backend. They cannot grant authority, bypass tenant scope, or change the declared permission floor.
- The `ref` reference resolution (Phase 1 of engine refinement, completed).
- The `on_error` semantics: `skip` / `abort` / `fallback`.
- The canonical first-win smoke uses `pipelines/verify-session.json`; the optional voice smoke uses `pipelines/voice-hello.json`.

**Beta elements** (may change in minor):

- New step ops added by actuators.
- New control operations such as `core:judge_route` and `core:await_decision` are additive and remain subject to ADF guardrails.

**Internal**:

- Internal pipeline-engine state machine.
- The exact format of intermediate context passed between steps.

The schema, facet purity check, and op registry are the executable boundary checks. If this document and the schema disagree, update this document in the same change; do not rely on an undocumented field.

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
- Tenant scoping under `confidential/{tenant-slug}/` (the `project_permissions` policy key is a legacy name for this same path segment).

**Internal**:

- The internal scanning / indexing strategy.

### 2.6 Customer Aggregation — **Stable (v1) as of 2026-05-07**

See [`CUSTOMER_AGGREGATION.md`](./CUSTOMER_AGGREGATION.md).

**Stable**:

- The `customer/` directory layout and `_template/` schema.
- The `KYBERION_CUSTOMER` env var as the activation mechanism.
- The slug pattern `^[a-z0-9][a-z0-9_-]*$`.
- The resolver API (`activeCustomer`, `customerRoot`, `resolveOverlay`, `overlayCandidates`).
- Resolution order: customer overlay → legacy personal fallback.

### 2.7 Trace Format — **Beta** (will be lifted to v1 after Phase B-1)

`Trace`, `TraceSpan`, `TraceEvent`, `TraceArtifact` types in `libs/core/src/trace.ts`.

**Beta** until Phase B-1 (cross-actuator integration) completes:

- The exact shape of the `Trace` object.
- The opt-in OTLP/HTTP exporter enabled by `OTEL_EXPORTER_OTLP_ENDPOINT`; local JSONL remains the authoritative trace store and exporter failure is non-fatal.

### 2.8 CLI — **Stable (v1)**

The set of `pnpm <command>` scripts in `package.json`.

**Stable**:

- Existing top-level scripts: `build`, `test`, `lint`, `typecheck`, `validate`, `doctor`, `mission`, `pipeline`, `cli`, `onboard`, `surfaces:*`, `dashboard`, `control`, `release:notes`.
- Release and migration helpers: `release:notes`, `migration:run`, `migration:rollback`.
- Meeting runtime checks: `doctor:meeting` and `test:meeting-dry-run`.
- The first-win ladder is `pnpm doctor` → `pnpm pipeline --input pipelines/verify-session.json`.
- Their flags and exit codes.

**Internal**:

- The internal helper scripts under `scripts/`.

### 2.9 Mission Artifact Review — **Beta**

The artifact review receipt and reviewer profile are exposed for governed
Mission extensions but may evolve before promotion to Stable.

**Beta**:

- `knowledge/product/schemas/artifact-review-receipt.schema.json`
- `buildArtifactReviewReceipt(...)`
- `resolveArtifactReviewerProfile(...)`
- `evaluateArtifactReviews(...)`
- Optional `excludedAgentIds` and `requiredCapabilities` filters on
  `resolveMissionTeamReceiver(...)`

**Internal**:

- `NEXT_TASKS.json` annotations such as `artifact_review_profile` and
  `artifact_review_receipt`
- Mission-local receipt file naming and review-round bookkeeping
- Finish failure classification and task reopen mechanics

Extensions should emit a schema-valid receipt and use the public evaluator.
They must not infer approval from a free-form review note or bypass artifact
re-hashing at reconcile/finish time.

### 2.10 Capability Provider / Adapter Boundary — **Beta**

The adapter boundary is the preferred extension point whenever multiple
providers implement the same capability. The capability contract and resolver
are provider-neutral; a provider descriptor selects an adapter and declares
runtime, platform, readiness, and fallback metadata.

**Additive by default**:

- A provider using an existing adapter is added through registry/configuration
  data, schema, readiness/security checks, and contract tests.
- A new execution protocol adds one adapter implementation and its versioned
  contract; callers continue to use the capability contract.
- Provider-specific branches in surfaces, routers, orchestration, or fallback
  code are not an extension mechanism and should be rejected in review.

See [Adapter-First Extension Policy](../../knowledge/product/governance/adapter-first-extension-policy.md)
for the required registration ceremony, security, UX, operations, and
maintainability rules.

## 2.11 Lifecycle order — **Beta**

The lifecycle graph is the ordering contract for extension hooks. A hook may
observe or repair a tool input during `pre_tool_use`; it must not assume that
`post_tool_use` means the whole task is complete. The `task_settled` event is
the terminal receipt point: retry, repair, fallback, and compaction work must
already be finished before it is emitted, and it is emitted at most once per
top-level pipeline run.

```mermaid
flowchart TD
  trust[project_trust] --> start[session_start]
  start --> discover[resources_discover]
  discover --> input[input]
  input --> before[before_agent_start]
  before --> pre[pre_tool_use<br/>serial preflight + repair]
  pre --> execute[tool execution<br/>parallel siblings]
  execute --> post[post_tool_use / post_tool_use_failure]
  post --> retry[retry / repair / fallback / compaction]
  retry --> settled[task_settled<br/>one terminal receipt]
  settled --> end[session_end]
```

The currently executable hook vocabulary is `pre_tool_use`, `post_tool_use`,
`post_tool_use_failure`, `user_prompt_submit`, `stop`, `stop_failure`,
`session_start`, `before_agent_start`, `session_end`, `subagent_start`, `subagent_stop`,
`pre_compact`, `post_compact`, `notification`, and `task_settled`. The
remaining graph labels are extension roadmap anchors; their presence in this
diagram does not imply a runtime hook has already been added.
`scripts/check_extension_order.ts` keeps the runtime vocabulary and this
contract from drifting.

`runOpPreflight` returns `{ decision, reason, repaired_input, terminate }`.
Listeners run serially in canonical order; only after all listeners finish may
the execution engine run sibling tools in parallel. A repaired input is
returned even when the final decision is `allow`, and the repair is included
in the admission result for audit and downstream dispatch.

Goal-driven workers expose the same model-entry discipline through an ordered
`preStep` chain. Each hook returns `enter(messages)` or `reject(reason)`;
rejection pauses before any model/tool call, while admitted messages are
appended in registration order. Input queue delivery is turn-boundary only:
`steer → follow_up → next_run → inject`, with mission-wide broadcast or an
explicit task/agent/session scope. Queue content is rendered as untrusted data
and never interrupts an in-flight turn.

Lifecycle hooks expose a separate `decision: allow | ask | block` disposition.
Multiple hooks aggregate monotonically (`block > ask > allow`); non-interactive
pipeline and worker boundaries project `ask` to a fail-closed block until an
interactive approval surface is connected.

## 3. Semver Rules

For each stable surface:

| Change                                                       | Bump                                             |
| ------------------------------------------------------------ | ------------------------------------------------ |
| Remove a feature, field, op, or behavior contract            | **major**                                        |
| Add a required field, narrow accepted values                 | **major**                                        |
| Add an optional feature, field, op                           | **minor**                                        |
| Add a new actuator                                           | **minor** (of the actuator); core stays the same |
| Doc-only / comment-only / refactor with no observable change | **patch**                                        |
| Performance improvement with no observable change            | **patch**                                        |
| Beta → Stable promotion                                      | **minor** of the surface, document in CHANGELOG  |

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

### 5.1 Meeting Runtime Boundary

The stable extension point for meeting participation is the actuator / CLI contract, not the browser automation internals:

- Use `meeting-actuator` ops and `pnpm meeting:participate` for integration.
- Treat `libs/actuators/meeting-browser-driver/` as internal; wrap it only through the meeting actuator or the participation CLI.
- Keep `voice-consent.json` mission-scoped. The coordinator checks it before recording/capture and re-checks before TTS speech.
- Use `pnpm doctor:meeting --mission <MISSION_ID>` and `pnpm run test:meeting-dry-run` before claiming meeting runtime readiness.

For FDE / customer engagements:

| Need                                      | Use this                                                    | Avoid                                                                       |
| ----------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| Customer-specific identity / vision       | `customer/{slug}/identity.json`, `vision.md`                | Editing `knowledge/personal/` when `KYBERION_CUSTOMER` is unset             |
| Customer-specific connections             | `customer/{slug}/connections/`                              | Editing `knowledge/personal/connections/` when `KYBERION_CUSTOMER` is unset |
| Customer-specific policy override         | `customer/{slug}/policy/`                                   | Editing `knowledge/product/governance/`                                     |
| Customer-specific mission templates       | `customer/{slug}/mission-seeds/`                            | Modifying core `pipelines/`                                                 |
| Customer-specific actuator                | A new actuator under `libs/actuators/` with its own version | Patching an existing actuator's behavior                                    |
| Customer-specific actuator behavior tweak | A wrapper actuator that calls the core one                  | Forking the core actuator                                                   |

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

## 8. Shared Utilities (Internal)

Common helpers (`slugify`, `retry`, `sleep`, `chunk`, `loadJson`/`ensureDir`) have exactly one canonical implementation in `@agent/core` (`libs/core/text-utils.ts`, `libs/core/async-utils.ts`, `libs/core/secure-io.ts`). See IP-09 (`docs/developer/improvement-plans-2026-07/IP-09_SHARED_UTILITY_CONSOLIDATION.ja.md`) for the history of why: independently-drifted local copies previously produced ID/output mismatches (mission dir names, file names) across call sites.

**Do not add a new local `function slugify(...)` / `function retry(...)` / etc.** Import the canonical version from `@agent/core` instead. If a call site genuinely needs different behavior (e.g. a different separator, max length, or fallback), pass options to the canonical function rather than hand-rolling a variant — see `SlugifyOptions` in `libs/core/text-utils.ts`.

# Marketing Workload Extension

Marketing workloads compose existing Stable surfaces: ADF v1, Actuator contracts v1, Knowledge Tier Layout v1, Customer Aggregation v1, and the approval store's human accountability/payload binding. `libs/core/marketing-workload.ts` is additive and does not change an existing Stable contract. Trace remains Beta and is evidence metadata, not an authorization source.

Production publishers must remain Distribution-only actuators. Before any external effect they must re-hash every artifact, evaluate G5 against the exact title/description/CTA/destination/visibility payload, and record approval ID plus hashes in the audit trail. A publisher must not create or mutate its own approval record.

Publishers must also execute G1 sensitive-data scanning before G5. Scan evidence must not contain the matched secret or PII value. Media validators must fail closed when ffprobe/ffmpeg inspection fails; absence of detector output is not evidence that black frames or silence are absent.
