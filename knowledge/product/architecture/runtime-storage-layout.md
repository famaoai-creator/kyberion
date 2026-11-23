---
title: Runtime Storage Layout
category: Architecture
tags: [storage, artifacts, workspace, tmp, cache, staging, tier, multi-tenant, retention]
importance: 8
last_updated: 2026-11-23
runtime_stages: [alignment, execution, review]
---

# Runtime Storage Layout

Where runtime data lives under `active/`. Every write is placed by two
questions, never by habit:

1. **Purpose** — how long does it live, and who may delete it?
2. **Partition** — who owns it: the platform (`system`), or a tier/tenant?

`active/shared/tmp/` is the answer to exactly one purpose (scratch). Writing a
deliverable, a workspace, a cache, or an inbound file there loses its owner,
its tier, and its retention — the 24h janitor deletes it, and surfaces never
see it.

## 1. Purpose → place

| Purpose                      | What belongs there                                                                 | Place                                                                                                                         | API                                                               | Retention                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| **scratch**                  | Intermediates and IPC handoffs a single run creates and consumes                   | `active/shared/tmp/<partition>/<domain>/`                                                                                     | `resolveStorageFloor('scratch', …)`                               | 1 day, delete (+2 days for unpromoted authored code, §3a)   |
| **staging**                  | External files copied in for perception / ingest                                   | `active/shared/staging/<partition>/<domain>/<job>/`                                                                           | `resolveStorageFloor('staging', …)`                               | 3 days, delete                                              |
| **cache**                    | Derived, re-generable data: digest-keyed sidecars, model / build trees, indexes    | `active/shared/cache/<partition>/<domain>/`                                                                                   | `resolveStorageFloor('cache', …)`                                 | 30 days per partition, delete (a miss only costs a rebuild) |
| **workspace**                | Directories a worker operates in: clones, sandboxes, browser profiles, device runs | `active/shared/runtime/workspaces/<id>/`                                                                                      | `createScratchWorkspace` (workforce/workspace-ledger.ts)          | lease + ledger sweep                                        |
| **artifact** (scope-owned)   | Deliverables, reports, evidence, exports of a mission / task / project / session   | `<missionDir>/artifacts/<class>/`, `<projectDir>/artifacts/<class>/`, `active/shared/runtime/session/<id>/artifacts/<class>/` | `writeScopedArtifact({ scope: { mission / project / … } })`       | closes with its scope (mission-artifact-closure)            |
| **artifact** (organization)  | Deliverables owned by an organization (daily digests, org-wide reports)            | `active/organizations/<tier>/<tenant\|shared>/<org>/artifacts/<class>/`                                                       | `writeScopedArtifact({ scope: { organization, tenant? } })`       | review_required — never silently expired                    |
| **artifact** (tenant/system) | Deliverables owned by a tenant or by the platform, with no narrower scope          | `active/shared/artifacts/<partition>/<class>/`                                                                                | `writeScopedArtifact({ scope: { tenant } })` / `{ system: true }` | review_required — never silently expired                    |
| **state**                    | Durable registries, cursors, quotas, pending flows — anything that must survive    | `active/shared/runtime/<domain>/` (+ `physicalScopedPath` for tenant namespaces)                                              | governed catalogs / `writeGovernedArtifactJson`                   | per retention-catalog entry                                 |
| **log**                      | Audit, process, surface, trace logs                                                | `active/shared/logs/`                                                                                                         | `logger`, audit chain                                             | per catalog entry: 30 days delete; `logs/audit` archived    |

Decision rule for the boundary cases:

- Must it survive the run that wrote it? Not scratch.
- Can it be rebuilt from inputs? Cache. Can't be rebuilt? State (or artifact).
- Will a person or surface look at it? Artifact — and publish it (§3).
- Does a process `cd` into it, or does it outlive one write? Workspace.

## 2. Partitions — system, tier, tenant

The floors (`tmp`, `staging`, `cache`, `artifacts`) share one partition rule
(`libs/core/storage-layout.ts`):

| Partition        | Segment                 | Holds                                                        | Enforcement                                                                                  |
| ---------------- | ----------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| system-wide      | `system/`               | Platform data that carries **no** tenant or personal content | none beyond default policy (public tier)                                                     |
| tier, untenanted | `<tier>/shared/`        | Tier data with no tenant binding (single-operator installs)  | tier-guard read gate for `personal` / `confidential`; tenant-bound personas are denied       |
| tier + tenant    | `<tier>/<tenant-slug>/` | Tenant data                                                  | tier-guard read gate + `tenant_scope.protected_prefixes` (cross-tenant deny, broker audited) |

- The order matches the rest of `active/` (`missions/<tier>/<tenant>/`,
  `projects/<tier>/<tenant>/`): tier first, then tenant. Reserved scope names
  (`public`, `confidential`, `personal`, `shared`) are never tenants.
- `system` is the floor-level equivalent of an event scope with
  `scope_kind: 'system'`. Never put tenant or personal data in it.
- Read grants on a floor root or an `active/shared` ancestor (for example the
  long-standing `active/shared/tmp/` grants) cover legacy, `system/` and
  `public/` data only. Reading a `personal/` or `confidential/` partition needs
  a grant that names `<floor>/<tier>/` (the Chronos roles hold
  `active/shared/artifacts/{personal,confidential}/`) or a deliberately broad
  `active/`-level grant; tenant scope then narrows it to the viewer's tenant.
- If `security-policy.json` is missing or unreadable, tier-guard refuses
  reads, metadata probes and writes on protected personal and confidential
  paths. Public reads and unpartitioned scratch remain available for bootstrap.
- Unpartitioned files at a floor root keep their owner's lifecycle (for
  example knowledge-index `cache/ki-*.json`, evicted by its own LRU).
- Scope-owned artifacts inherit the tier and tenant of their owner directory
  (a confidential tenant mission's artifacts live under
  `active/missions/confidential/<tenant>/<id>/artifacts/`).
- A path directly under a floor root without a partition segment is
  **legacy**: it predates this layout and carries no governing tier.

### Managed tool runtimes

Managed tool runtimes split by purpose, and each half is resolved in one place
(`libs/core/tool/tool-runtime-policy.ts`):

| Data                                                           | Location                                          | Resolver                                               |
| -------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Installs: venvs, managed binaries, `state.json`, provider CLIs | `active/shared/runtime/tool-runtimes/<dir>/`      | `resolveToolRuntimesRoot()`, the tool-runtime registry |
| Downloads: uv / pip / XDG caches, `HF_HOME` model weights      | `active/shared/cache/system/tool-runtimes/<dir>/` | `resolveToolRuntimeDownloadCacheDir()`                 |

Installs are state, not cache: they are approval-gated, `state.json` records
the install/pin provenance, and installed files keep upstream mtimes that the
cache partition's per-file TTL would tear apart. Downloads are re-generable but
`review_required` in the retention catalog because multi-GB weights are fetched
deliberately and keep their download mtime. The download-cache root is never
an install target and is never searched for interpreters or binaries; only the
runtime root is. Never build either path by hand.

### Service-preset cache

`executeServicePresetCached` (`libs/core/service/service-engine.ts`) keeps its
TTL cache on the cache floor (`libs/core/storage/service-preset-cache.ts`):

```
active/shared/cache/<tier>/<tenant|shared>/service-preset/project/<projectId>/<hash>.json
active/shared/cache/<tier>/<tenant|shared>/service-preset/global/<hash>.json
```

- The tenant segment is the tenant of the call's admitted binding
  (`resolveTenantAlias` of the admission's security scope). A call without an
  admission uses the tier's `shared` partition. The project is the admitted
  project, or the caller's `project_id` when there is no admission; without
  one the entry goes to `global/`.
- The tier of an admitted call is the admission's `write_tier` (a miss writes
  the partition); a `tier` option that differs is refused. Unadmitted calls
  default to `confidential`.
- A project id that is not a valid floor segment (admitted ids may contain
  `:`) is stored under `id-<sha256 prefix>`; valid ids stay readable.
  `servicePresetCacheProjectSegment` is the one mapping the writer and
  offboarding share.
  Project offboarding accepts only ids that are already physical segments, so
  it never reaches an `id-<hash>` subtree; those subtrees are removed by the
  tenant offboarding of their partition, the janitor's `expiresAt` sweep and
  the 30-day cache floor rule.
- Ownership follows from the path. tier-guard and `tenant_scope` protect the
  `personal` / `confidential` partitions like every floor, so a process bound
  to one tenant cannot write another tenant's entries, and no code reads an
  owner out of an entry.
- Each entry records its tier, tenant and project and is served only from the
  partition those name: an entry copied into another partition is a miss.
  Its own `expiresAt` is checked on read (an expired entry is a miss and is
  rewritten). The janitor also deletes entries whose `expiresAt` passed
  (`scanServicePresetCache`, audited, counted with the storage floors); the
  cache floor rule (30 days by mtime) stays as the backstop.
- It replaces the flat `active/shared/data-vault/` store. That directory is a
  legacy retention-catalog entry now: nothing writes there, and the janitor
  deletes leftovers 30 days after their last write (audited) until the entry
  is removed. The `active/shared/data-vault/` write grants of `run_pipeline`
  and `run_super_pipeline` remain only so the janitor can delete those
  leftovers; remove them with the legacy entry.

### Process start-up caches

Two platform caches keep repeated child processes cheap. Both hold
repository code or host facts only, never tenant data. Deleting either only
costs the next process the work again.

| Cache                                                       | Writer                                                          | Content and key                                                                                                                                                                                                                                                                      | Retention / off switch                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `node_modules/.cache/kyberion-ts-loader/` (not a floor)     | `scripts/ts-loader-cache.mjs` (used by `scripts/ts-loader.mjs`) | One transpiled module per file, `<2 hex>/<sha256>.transpiled` (not a code extension, so repository scanners skip it); key = the cache module's own text + TypeScript version + absolute path + source. Sources under `active/`, `knowledge/`, `customer/`, `vault/` are never cached | Pruned by the loader (written > 30 days ago, at most daily); `KYBERION_TS_LOADER_CACHE=0`          |
| `node_modules/.cache/kyberion-stt-discovery/` (not a floor) | `libs/core/voice/local-stt-discovery.ts`                        | `candidates.json`: (backend, source, binary, version) per detected local STT backend; key = platform + PATH + registry content + managed runtimes' bin lstat and site-packages mtimes                                                                                                | 10 minutes in-file (`KYBERION_STT_DISCOVERY_CACHE_TTL_MS`, `0` = off); managed installers clear it |

**Trust-model exception: neither cache is on a floor.** The transpile cache's
entries are executed as code by whoever runs the loader (operator,
mission_controller, CI), and the STT discovery result names the binaries the
speech-to-text bridge executes. Every floor under `active/shared/` is
writable by governed personas through secure-io (`default_allow`), so an
entry there could be planted by a role that may write data but not code.
Both therefore live in `node_modules/.cache/`, which secure-io denies to every
persona and authority role (SUDO authority aside), and they are the only
runtime stores that bypass secure-io and the retention catalog. The rules
live in one module, `libs/core/private-host-cache.mjs`:

- the loader is what makes TypeScript importable, so it cannot import
  secure-io (itself TypeScript), and secure-io refuses `node_modules/` by
  design; the helper uses `node:fs` on these directories only (governance
  import baseline, core-fs-exception-boundary);
- the cache root must be owned by the running uid with no group/other write
  bit; directories are created 0700 and files 0600; each file is opened
  without following symlinks and `fstat`ed, and one with another owner or a
  group/other write bit is deleted, never used;
- an override directory is honoured only outside the checkout or under its
  `node_modules/`, judged on the realpath of its deepest existing ancestor;
- on Windows (no uid, no POSIX mode) both caches are off unless
  `KYBERION_WINDOWS_PRIVATE_CACHE=1`;
- writes go to a unique temp file renamed into place, and every cache error
  is a miss.

The STT cache also re-validates on every hit: candidates are rebuilt from
the governed registry, and a binary is accepted only where the probe could
have found it (the tool's own managed python, or a PATH directory outside
`active/`, `knowledge/`, `customer/`, `vault/`). secure-io also refuses to
create a symlink into, or write through one to, a tree the persona may not
write (canonical-path guard), so a link from `active/` cannot reach these
caches.

### Owner scope (deterministic placement)

A write that belongs to an owner — a mission, task, project or organization —
is placed by the **owner's own record**, never by the caller's guess
(`libs/core/governance/owner-scope.ts`):

| Owner        | Source of tier / tenant / organization                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| mission      | `mission-state.json` where the mission actually lives (any tier, tenant-nested or not)               |
| project      | the project record (`tier`, `tenant_slug`, `organization_id`)                                        |
| organization | its directory `active/organizations/<tier>/<tenant\|shared>/<org>/` (ids are unique per tenant only) |

- `resolveOwnerScope(owner, hint?)` / `resolveMissionDir(id, hint?)`. A caller
  tier/tenant is a **hint that may only narrow**: it may select among same-id
  owners, and it must agree with the owner it resolves to.
- Lookup does not depend on `KYBERION_TENANT`, but visibility does: an identity
  bound to tenant T never resolves another tenant's owner (it reads as not
  found — nothing is disclosed).
- Failures are `OwnerScopeError` with a code and a remedy, rendered
  `[CODE] what — why | next: remedy`:
  `OWNER_NOT_FOUND` (no guessed directory is ever created),
  `OWNER_AMBIGUOUS` (same id in several tenants — pass tier/tenant),
  `SCOPE_CONTRADICTS_OWNER` (with `expected` / `actual`),
  `OWNER_ID_INVALID`.
- `writeScopedArtifact` and `readScopedArtifactIndex` (mission, task, project,
  organization scopes), mission → project links, project operational state and
  the orchestration / task-event / journal mission directories all resolve
  through it. Session, tenant and system scopes have no owner record and keep
  their explicit (or default) tier.
- `findMissionPath` / `loadState` answer from the same resolver for an existing
  mission (owner-scope registers itself as path-resolver's mission locator);
  their directory scan only finds a pre-materialized mission that has no
  `mission-state.json` yet. An id in several tenants fails closed
  (`OWNER_AMBIGUOUS`) instead of returning the first match, and a mission
  directory whose state this process may not see fails with
  `OWNER_NOT_VISIBLE` rather than reading as absent (which would invite a
  second copy). Identity resolution treats both as "no mission identity".
- **Strict vs lenient lookup.** `findMissionPath` is the _strict_ lookup and
  every caller is pinned to a reason in `tests/mission-lookup-boundary.test.ts`:
  _lifecycle_ (mutation / governance / operator tooling: the structured refusal
  is reported), _scope-derivation_ (tier, tenant, visibility or classification
  is derived from the mission, and "absent" would be a looser default, so it
  must fail closed) and _placement_ ("absent" would mean another location or a
  second copy). Only a path where absent is a conservative no-op — an optional
  evidence write, a report row, a list/feed filter that already denies a
  tenant-less item, "no mission identity" for a permission check —
  uses `missionPathOrNull(findMissionPath, id)` from `@agent/core/mission-lookup`,
  which treats `OWNER_AMBIGUOUS` / `OWNER_NOT_VISIBLE` as absent. A new direct
  caller fails the boundary test until it is registered with its category.
- Agent input (surface `steer:` / `follow-up:`, `enqueueMissionAgentInput`) is
  queued beside the existing mission only; input for an unknown mission is
  refused with `OWNER_NOT_FOUND` rather than parked where it would never be read.

The artifact ownership registry (`active/shared/runtime/artifacts/registry.jsonl`)
is append-only; its current state is the **latest row per `artifact_id`**.
Queries de-duplicate before filtering, so a superseded row (e.g. a mission
deliverable since promoted to its project) never matches its old owner. The
storage janitor compacts the file to the latest row per artifact **and owner**,
so offboarding still sees every scope that ever owned an artifact.

### Dot state domain

Resident-dot loop state is **state** (durable, per retention-catalog entry) under
one domain, `active/shared/runtime/dot/`, and is addressed only through
`dotStatePath(charter, ...parts)` (`libs/core/dot/dot-state-paths.ts`):

| Dot scope  | Place                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------- |
| untenanted | `active/shared/runtime/dot/<file>` (`work-results.jsonl`, `kr-ledger.jsonl`, `outcomes.jsonl`, …) |
| tenant     | `active/shared/runtime/dot/tenants/<slug>/…` via `physicalScopedPath` (+ organization segment)    |

Tenant prose (memory, follow-up reasons, inbound event bodies, work results)
never goes in a system-floor file; the tenant-scoped inbound events ledger
lives under the tenant namespace. Pre-partition tenant copies under
`dot/tenants/<slug>/` are moved for a live tenant only by the
operator-reviewed `pnpm kyberion dot migrate-state`; when the tenant is
offboarded they are exported and soft-deleted automatically (audited) like the
tenant's other runtime state, while its partitioned dot state stays
review-required (`not_offboarded`). The older flat dot ledgers directly under
`active/shared/runtime/` (wake, action, inbox) stay shared and carry
category-only text for tenant dots. One `storage-retention-catalog.json` entry
covers `active/shared/runtime/dot`. See
[resident-dot-model](./resident-dot-model.md).

### Metrics ledgers (resource usage, execution metrics)

Both ledgers of the shared `MetricsCollector` (`libs/core/analysis/metrics.ts`) place
each row by the row's own `scope`; callers do not choose the file. Usage
accounting (`recordResourceUsage`) and execution metrics (`record`: latency,
tokens, cost per component call) share one mechanism:

| Record scope                                      | Resource usage                                                                    | Execution metrics                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| none, or `public` without a tenant (system)       | `work/metrics/resource-usage.jsonl` (legacy repo-wide file)                       | `work/metrics/execution-metrics.jsonl` (legacy repo-wide file; interventions too)         |
| carries a `tenant_slug`, or personal/confidential | `active/shared/runtime/usage-ledger/<tier>/<tenant\|shared>/resource-usage.jsonl` | `active/shared/runtime/execution-metrics/<tier>/<tenant\|shared>/execution-metrics.jsonl` |

- Readers choose partitions with the same read scope
  (`MetricsLedgerReadScope`): `loadResourceUsageHistory(read)` and
  `loadHistory({ read })`. Omitted reads the system partition only;
  `{ scope }` reads one owner's partition (`includeSystem` adds the system
  one — the mission retrospective uses its mission's tier/tenant),
  `{ tenants }` reads every tier partition of those tenants (`includeSystem`
  as above; tenant cost reports and tenant budgets add it for execution
  metrics, whose unscoped rows are attributed by mission id) and
  `{ all: true }` is the operator aggregate (cost report without a tenant
  filter, terminal HUD, spend guard, health regressions, operator home).
  `reportFromHistory(read)` / `detectRegressions(multiplier, read)` order the
  merged rows by timestamp. Learning signals read the system partition only
  (their clusters are tenant-free).
- `<ledger>/{personal,confidential}/` are `tenant_scope.protected_prefixes`:
  tier-guard denies a tenant-bound process another tenant's partition on read
  and write.
- **Persona read gate.** A personal/confidential partition
  `<tier>/<tenant>/` is readable only by a persona/role/authority that may
  read `knowledge/<tier>/<tenant>/` (`knowledge/<tier>/` for the untenanted
  `shared` segment): tier-guard reuses the knowledge decision
  (`personaTierReadDecision` — SUDO scope, authority, role and persona
  grants, tier restriction) for that mirror path, after the tenant check. So
  tenant-scoped roles that read their tenant's knowledge (`slack_bridge`,
  `chronos_tenant_runner`, `organization_operator`) also read that tenant's
  partitions, never another tenant's. There is no separate persona table. Aggregate readers skip a denied
  partition instead of failing and log a `debug` line in the diagnostic
  format (`<ledger> partition skipped — … | next: … | evidence: <path>`).
  A process whose persona may not read a tier (e.g. a plain `worker`
  without the `mission_controller` role) sees only the system partition and
  the tiers it may read.
- **Reports say when they are partial.** Report and summary readers (cost
  report, operator home, Chronos cost summary, terminal HUD, `pnpm kyberion doctor`,
  soak) pass `onWithheld` and call `metricsWithheldNotice`: one `warn` line
  in the diagnostic format, and the output itself carries
  "N metrics partition(s) withheld for this persona — totals are partial"
  (`partial_notice` / `partialNotice`, a `PARTIAL:` line in text output).
- **Enforcers never under-count.** Cap and limit enforcers (spend guard, org
  budget governor, generation-cost dedup) read only through
  `aggregateMetricsForEnforcement`: it assumes the governed read-only role
  `metrics_cap_reader` (security-policy `authority_role_permissions`: the two
  ledger roots, no `knowledge/`, no write), bound to the caller's tenant, so
  every tier of the enforcer's scope is counted whatever the caller's
  persona while tenant isolation still holds. The caller gets numbers only —
  sums of measure names declared before any row is read — and only an
  allowlisted enforcer (`METRICS_ENFORCERS`) may call it. The per-row
  classifier never sees a raw row: it gets `projectEnforcementRow`, a
  whitelist of timestamp, cost, token counts, mission / usage / accounting
  ids, tier / tenant / organization scope and the dot actor.
  - Spend guard: a tenant-bound process always evaluates its bound tenant's
    caps over that tenant's ledgers (a different requested tenant, e.g. a
    brokered mission's, is debug-logged and ignored — authorization is the
    scope layer's); an unbound process evaluates a requested tenant over
    `{ tenants: [t], includeSystem: true }`, else the global caps. Slugs are
    compared trimmed and lower-cased. Its short cache is keyed by
    tenant/day/mission and bounded; costed rows the process appends are added
    to matching entries at append time (`onExecutionMetricsAppend`), so
    zero-cost bursts keep hitting the cache and only an unattributable costed
    row drops entries.
  - Budget governor: a scope wider than the bound tenant that could not see
    every partition reports `cost_status: 'partial'` with
    `withheld_partitions`, never a complete total. It is logged at `debug`
    per call rather than audited: it runs on every reasoning call, returns no
    row content, and the role's grant is read-only and narrow. Tier-guard
    admits the role only through a role grant that names a ledger root
    (`ledgerRoleReadGrant`), so broad grants such as `active/shared/` never
    bypass the persona gate.
- Rows written to a system file before partitioning stay there as
  **legacy**: each reader filters them by the row's own scope, so a tenant
  reader still sees its own old rows and the system reader never sees tenant
  rows; in every read mode a legacy tier row also inherits tier-guard's read
  decision (tenant and persona) for its partition, so it is visible only
  where its partition would be. There is no split command — the file is not
  rewritten, so nothing can be lost or duplicated by a half-run migration.
  The one exception is tenant offboarding (`scope-offboarding.ts`): for each
  ledger, under the ledger-file lock every appender also takes
  (`metricsLedgerLockId`), it recomputes the tenant's legacy rows from the
  file as it is at that moment, exports them, then removes them with one
  atomic, audited, approval-gated rewrite
  (`SCOPE_OFFBOARD_USAGE_LEDGER_PRUNE` / `SCOPE_OFFBOARD_EXECUTION_METRICS_PRUNE`),
  so rows appended after the plan survive; it also exports + soft-deletes the
  tenant's partitions.
- A row's tenant comes from one resolver, `metricsRowTenant`
  (`storage-layout.ts`): `scope.tenant_slug` / `scope.tenant_id`, then the
  pre-canonical top-level `tenant_slug` / `tenant` / `tenant_id`. Placement,
  legacy-row gating, offboarding and the budget governor all use it.
- A tenant-bound process that records a personal/confidential row without a
  tenant gets its bound tenant stamped on (a bound process may not write
  `<tier>/shared/`). A row that still cannot be written is logged at warn,
  never dropped silently.
- An execution-metrics row whose scope cannot be placed (unknown tier,
  invalid tenant slug) is still counted and never downgraded: it keeps its
  tier (an unknown tier fails closed to `confidential`; `public` goes to the
  system file), takes the bound tenant or the `shared` segment, drops its
  tenant fields and is flagged `scope_invalid: true`; a warn line names the
  producer's error. `recordResourceUsage` keeps throwing on an invalid scope
  so its callers decide (e.g. direct-CLI usage warns and records nothing
  rather than downgrade a confidential row).
- An execution-metrics row without a `scope` or tenant field stays in the
  system file even when it carries a tenant mission's `mission_id`:
  placement follows the row's own scope and tenant only, as for usage rows.

### Hybrid audit ledger (system ledger, tenant ledgers)

`ledger.record(type, data)` (`libs/core/governance/ledger.ts`) writes a hash-chained
entry. Unlike the metrics ledgers, a record with a `mission_id` takes its
scope from **its mission's location** (`active/missions/<tier>/<tenant|shared>/<id>`,
or its archive dir) — the path tier-guard enforces — filling what the record
omits and overriding a conflicting value; organization and project come from
the mission state inside the located tenant. A tenant mission is therefore
never recorded as `public` or untenanted.

| Record                                      | Detailed entry                                                                       | Metadata entry (`MISSION_EVENT:<type>`)                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| untenanted mission (public / `shared`)      | `<mission>/evidence/ledger.jsonl`                                                    | `active/audit/system-ledger.jsonl`                                                   |
| tenant mission (any tier)                   | `<mission>/evidence/ledger.jsonl`                                                    | `active/shared/runtime/tenant-ledger/<personal\|confidential>/<tenant>/ledger.jsonl` |
| archived tenant mission, or a tenant record | `active/shared/runtime/tenant-ledger/<personal\|confidential>/<tenant>/ledger.jsonl` | —                                                                                    |
| no mission ledger, untenanted               | `active/audit/system-ledger.jsonl`                                                   | —                                                                                    |

- **The system ledger carries no tenant data**: no tenant slug and no tenant
  mission metadata. Entries written before this rule (2026-10, finding D9)
  stay where they are — the chain is append-only and is never rewritten, so
  pre-D9 rows (and tenant offboarding, which leaves them) still hold tenant
  mission ids.
- **Partitions live only under protected tiers.** A `public` tenant record is
  stored in the tenant's `confidential` partition; its recorded scope keeps
  tier `public`. There is no `tenant-ledger/public/`.
- A tenant partition is read (chain tail) and appended as the tenant-bound
  `tenant_ledger_store` role, bound to the record's tenant. Its subtrees are
  `tenant_scope.protected_prefixes`; tenant offboarding exports and
  soft-deletes the tenant's partitions (target kind `tenant_ledger`).
- **Refusals never throw and never fall back to the system ledger.** When the
  process is bound to another tenant than the record's, when the mission state
  names another tenant or tier than its location (or a tenant its location
  does not carry — e.g. an ephemeral mission), or when the mission id exists
  but is not resolvable by this process, `record` writes the mission's
  detailed entry (if it has an active mission ledger) and skips the tenant
  entry with a diagnostic warn. A failure writing the metadata entry is a warn
  too (the detailed entry is already durable); the detailed / no-mission entry
  itself still fails loudly, and a ledger whose tail cannot be parsed refuses
  to append (`[LEDGER_TAIL_UNREADABLE]`) instead of restarting its chain.
- **Residual case**: a `mission_id` that no process can place — no active or
  archived mission dir anywhere this process can see (a purged mission, or a
  Chronos `MISSION_RUNTIME_REMEDIATION` lease for an id that never was a
  mission) and no `tenant_slug` in the record — stays a system record, but
  metadata only (D4): the entry keeps the raw `mission_id`, `type`, `role` and
  a mission-kind scope and carries `payload_withheld: 'mission_unplaceable'`,
  never the payload itself nor any digest of it (a fast hash of a payload that
  may carry credential-like fields would be guessable); `record` warns naming only the type and id. A record that
  names its `tenant_slug` explicitly still routes to that tenant's partition
  with full detail. The system ledger is append-only: rows written before D4
  keep their payloads (not rewritten).
- Each file is its own hash chain. `verifyAllLedgerIntegrity()` (used by
  `pnpm audit:verify` / `system:audit_verify` and `system:pulse_status`)
  verifies the system ledger plus every tenant partition the process may
  bind; partitions of another tenant than a bound caller's are counted as
  withheld, never read or named. `finish` verifies the system ledger and the
  mission's tenant partition (`verifyScopedIntegrity`).
- Readers: `loadForScope(filter)` reads the system ledger plus, for a filter
  that names tenants (`tenant_slug`, `tenant_slugs`), those tenants'
  partitions under the reader's own tier-guard decision — a client-supplied
  tenant only narrows; a partition the reader may not see is skipped.

### Approval store (system tree, tenant partitions)

Approval requests are addressed by `(storageChannel, id)` everywhere; where
the record is stored follows its scope
(`libs/core/governance/approval-store-location.ts`):

| Record                                                               | Request / passkey challenges                                                                                            | Event log                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| untenanted (Slack, plugin, operator), or a pre-activation tenant one | `active/shared/coordination/channels/<ch>/approvals/{requests,passkey-challenges}/<id>.json`                            | `active/shared/observability/channels/<ch>/approvals.jsonl`                                     |
| `scope.tenant_slug` set (any tier)                                   | `active/shared/runtime/tenant-approvals/<personal\|confidential>/<tenant>/<ch>/{requests,passkey-challenges}/<id>.json` | `active/shared/runtime/tenant-approvals/<personal\|confidential>/<tenant>/<ch>/approvals.jsonl` |

- **Exception**: a `tenant-activation` request for a tenant that is not yet
  active (`isTenantActivationActive`) stays in the system tree.
- As for the ledgers, a `public` tenant record is stored in the tenant's
  `confidential` partition and keeps tier `public` in its scope. The partition
  tiers are `tenant_scope.protected_prefixes`.
- A partition is read and written as the tenant-bound `tenant_approval_store`
  role, bound to the record's tenant. The `tenant_approval_partition_index_reader`
  role lists tenant directory names only (descendants denied), so an unbound
  process can enumerate partitions without reading them.
- **Lookup**: the system tree first (it still holds legacy tenant records),
  then the partitions this process may bind — only its own tenant when it is
  bound to one, every tenant otherwise. A process bound to tenant A never
  finds tenant B's record. An id found in two places fails
  `[APPROVAL_LOCATION_AMBIGUOUS]`. Mutators write back to where the record was
  found, never to a caller-derived location.
- **Legacy records**: tenant records written to the system tree before the
  partitions existed stay readable and writable in place.
  `node dist/scripts/approval/approval_store_hygiene.js --migrate-tenant-partitions`
  lists them (dry run); add `--apply` to move each one under its record lock
  (write + fsync + read-back, move the request's passkey challenges the same
  way, remove the system copy, audit-chain entry `migrate_tenant_partition`).
  The run is idempotent and refuses (`[APPROVAL_MIGRATION_CONFLICT]`) when the
  partition already holds the id with different content. A reader that does
  not take the record lock may briefly see `[APPROVAL_LOCATION_AMBIGUOUS]`
  while a record is between its two copies; if the process crashes in that
  gap, re-running `--apply` resolves it. Old `approvals.jsonl` lines stay in the system log
  as history. The regular hygiene report counts the records still to move.
- The hygiene sweeps (expired passkey challenges, fixture purge) and the
  learning-signal rejection reader cover the partitions too. Retention is
  `review_required`; tenant offboarding exports and soft-deletes the tenant's
  partitions (target kind `tenant_approvals`).

### Delegation trace and records

The delegated-task trace and the resumable delegation records
(`libs/core/workforce/delegated-task-observability.ts`) carry tenant instruction,
context and result text, so they live in the registered ledger root
`active/shared/runtime/delegation-records/` (`PARTITIONED_RUNTIME_LEDGER_ROOTS.delegations`):

| Delegation | Trace                                     | Records / child inboxes                                             | Notification queue                          |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| untenanted | `system/delegations.jsonl`                | `system/records/<id>.json`, `system/records/child-inbox/`           | `system/notifications.jsonl`                |
| tenant     | `confidential/<tenant>/delegations.jsonl` | `confidential/<tenant>/records/<id>.json`, `…/records/child-inbox/` | `confidential/<tenant>/notifications.jsonl` |

- A tenant delegation is always `confidential` (it holds tenant prose). The
  record's `tenant_slug` (stamped from the bound tenant at start) decides
  every later write, so settlement, activation claims and resumes stay in
  that partition; a resume refuses a tenant other than the bound one
  (`[DELEGATION_TENANT_SCOPE_MISMATCH]`), and a cold-resume worker process is
  spawned with `KYBERION_TENANT` set to the record's tenant.
- Tenant partitions are `tenant_scope.protected_prefixes` and a dedicated
  store root (`TENANT_STORE_LEDGER_ROOTS.delegations`): only the tenant-bound
  `delegation_record_store` role, bound to the partition's tenant, reads or
  writes them (locks stay under the caller's role). The system partition keeps
  the ordinary runtime grants (`chronos_gateway` names `system/`).
- **Readers.** `loadDelegatedTaskRecord(id)`: a tenant-bound process looks only
  in its own partition; an unbound process looks in `system/`, then every
  tenant partition, then the legacy directory.
  `listActiveDelegatedTaskRecords(limit, read?)`: omitted `read` is the
  process's own scope (bound tenant, else `system/` only); `{ tenants,
includeSystem }` narrows for an unbound reader (the Concierge response
  status passes the selected company); a bound reader's request for another
  tenant or `system/` is dropped. Learning signals read `system/` plus the
  legacy trace only (closed tokens).
- **Legacy shared copies** (`active/shared/observability/delegations.jsonl`
  with its rotated `delegations-YYYYMMDD-HHmmss.jsonl` segments, and
  `active/shared/observability/delegations/`) are never appended to again.
  A legacy record is attributed by its `tenant_slug`, else by its mission's
  location (`active/[archive/]missions/<tier>/<tenant>/<id>`): a bound reader
  sees only records attributed to its tenant (an unresolvable mission hides
  the record), an unbound reader sees them as before. The next write of a
  legacy record lands in its partition and removes the shared copy
  (migration on first write; a legacy child inbox is read until the
  partitioned one exists). Tenant offboarding exports and soft-deletes the
  tenant's legacy records and child inboxes (target kind
  `delegation_legacy_record`) and, under a per-file lock, exports then prunes
  the tenant's rows from the legacy trace and each segment in one atomic,
  audited rewrite (`SCOPE_OFFBOARD_DELEGATION_TRACE_PRUNE`); attribution uses
  the tenant's mission ids taken before its mission trees are removed, which
  the post-offboard verification reuses. Rows with neither a stamp nor a
  mission cannot be attributed and stay (readable by unbound processes only).
- **Notification queue.** The background-delegation completion queue
  (`mission/delegation-notifications.ts`; tenant instruction / result
  excerpts) lives in the same partitions: `system/notifications.jsonl` and
  `confidential/<tenant>/notifications.jsonl`, written to the delegation's
  partition (its record's `tenant_slug`, else the bound tenant) as
  `delegation_record_store`. A tenant-bound process lists and claims only its
  own partition (enqueueing for another tenant is refused,
  `[DELEGATION_TENANT_SCOPE_MISMATCH]`); an unbound host — the delivering
  mission worker — drains `system/`, every tenant partition and the legacy
  queue. Claiming rewrites the partition file under the
  `delegation-notifications` lock (delivered at most once, as before).
- **Legacy notification queue** (`active/shared/runtime/delegations/notifications.jsonl`)
  is never appended to or rewritten at runtime. A row is attributed by its
  `tenant_slug`, else by the partition holding its delegation record, else by
  its mission's location; a bound reader sees only rows attributed to it and
  unattributed rows reach unbound processes only (fail closed). Claiming a
  legacy row appends it, claimed, to its partition; that copy shadows the
  legacy row (same `notification_id`), so it is never delivered again and
  previously claimed rows stay claimed. Tenant offboarding exports then prunes
  the tenant's rows (stamp, mission, or one of its delegation ids) under the
  queue lock in one atomic, audited rewrite
  (`SCOPE_OFFBOARD_DELEGATION_NOTIFICATION_PRUNE`, streamed; a file with an
  oversized line is refused, not rewritten); the partition queue is exported
  and soft-deleted with the partition.

### Tenant runtime partitions (backup, restore, offboarding)

An ingest sync saves the changed-item work list under
`active/shared/artifacts/confidential/<tenant>/ingest-sync/<source>/` before
advancing its cursor. The cursor names the content-addressed batch and a
later sync refuses a missing or mismatched referenced batch. Tenant backup,
restore and offboarding include the work lists alongside the cursor tree.
`ingest:sync_source` accepts `list_batches: true` or `recover_batch_id` for a
single `source_system`. Recovery reads the saved list without advancing the
cursor or contacting the source. Knowledge landing still uses the explicit
ingest commit.

- `TENANT_RUNTIME_PARTITION_ROOTS` (`storage-layout.ts`) derives one list
  from `PARTITIONED_RUNTIME_LEDGER_ROOTS` and `PARTITIONED_RUNTIME_STATE_ROOTS`
  (`family`, `appendOnly` for every ledger root, `hashChained` for the tenant
  ledger, `storeRole` for the dedicated-store roots).
  `tenantRuntimePartitionPaths(tenant, exists)` lists `<root>/<tier>/<tenant>`
  per tier and `tenantRuntimePartitionOf(path)` maps a path back; `system/`,
  `<tier>/shared` and reserved names are never a tenant.
- Tenant backup, the tenant restore allowlist and tenant offboarding all walk
  this list, so a newly registered root is covered by all three. Offboarding
  maps each key to a target kind in a `satisfies Record<…>` table (the
  pipeline-library-run, autonomy-learning, external-operation and grant roots
  export + soft-delete as `tenant_runtime_state`; hearing and
  discussion-create-request receipts map to `'not_offboarded'` — review-required, never
  auto-offboarded, though backups include them), so a new root fails to
  compile until its disposition is decided. Null-disposition partitions are
  never listed or counted as post-offboard leftovers.
- Offboarding execution is bound to a reviewed dry run: an approved execute that names
  no `expectedPreviewId` (CLI `--preview-id`) returns `approval_required` and deletes
  nothing. Tenant-nested missions (`active/missions/<tier>/<tenant>/<id>`) are collected
  as `mission_tree` targets alongside flat ones. Shared files that hold several tenants'
  lines (the ingest dedup registry, legacy metrics ledgers, the legacy delegation trace and
  notification queue) are pruned by rewriting them under the lock their appenders take,
  from a fresh read at prune time; the removed lines survive only in the offboarding
  export. The export manifest is rewritten after each prune with the actual counts and
  names an export file only once it exists, so a lock timeout part-way leaves a manifest
  that matches the disk. The service-preset cache is offboarded by path
  (`scope-offboarding-cache.ts`): a tenant offboarding exports and soft-deletes
  `active/shared/cache/<tier>/<tenant>/service-preset/` of every tier; a project
  offboarding removes `…/service-preset/project/<id>/` from its filter tenant's
  partition only. Without a filter it removes the untenanted `<tier>/shared/` subtree
  plus the subtree of the single tenant the project's lineage resolves to (workspaces,
  active and archived missions, the project registry record); when a tenant partition
  holds the project but the lineage names no tenant or several, it refuses with
  `PROJECT_SERVICE_PRESET_CACHE_AMBIGUOUS` (rerun with a tenant filter). Another
  tenant's partition is never claimed. The rest of a tenant's cache floor partition is
  not offboarded and expires under the cache floor rule.
- LEGACY, removed with the `active/shared/data-vault` retention entry: offboarding
  also exports and soft-deletes flat data-vault entries that a tenant-admitted call
  wrote (key `<tenant>:<projectId>:<binding>:…` with the entry's projectId). A tenant
  offboarding claims the tenant's entries; a project offboarding claims the project's
  entries of its filter tenant or, unfiltered, of its single lineage tenant, and
  refuses with `PROJECT_SERVICE_PRESET_CACHE_AMBIGUOUS` when entries exist but the
  lineage names no tenant or several. Unadmitted entries are shared by definition and are
  never claimed; the earlier "projectId equals the tenant slug" match is dropped.
- A restore refuses (`[BACKUP_RESTORE_APPEND_ONLY_CONFLICT]`) to lay an
  append-only partition or customer decision case over a target that already
  holds files. A chain has no head anchor, so the restore relies on this guard. The target is checked again
  after staging and immediately before placing the staged ledgers. Every
  staged ledger file uses exclusive creation, so a live file created after
  the final check keeps its bytes. A restore into the live checkout,
  offboarding execution, and the destructive janitor run share one
  non-waiting maintenance lock. A competing invocation fails before work
  starts. Lock files are excluded from backup and restore. Quiesce ordinary
  writers before restoring a multi-file partition. Append-only partitions and, on
  a tenant restore, invites are extracted into staging, never in
  place: a torn (unparseable) last `.jsonl` line is trimmed there, restored
  tenant-ledger chains are verified there when the target's audit chain key id
  equals the archive's `chain_key_id` (every entry HMAC-chained under that id;
  else `deferred_key_mismatch`; the key never rides in a tenant archive), and
  the archive's invites move straight into
  `<partition>/.restore-quarantine/<restore-id>/`, leaving live records as
  they are.
- Every restore stages and quarantines standing Grant records, pending
  Grant recovery intents, and the `grant-standing` approval channel. This
  includes tenant and shared Grant storage and tenant and legacy system
  approval paths. Personal-owner approvals remain in the archive because
  restore has no personal-owner I/O authority. Archived authorities stay
  outside active lookup paths. Existing Grant and approval records are preserved.
- The main restore extracts an exact list of allowed archive members without
  directory recursion. It never moves target files based on a change observed
  during extraction. Staged partitions, lock files, and any credential roots
  withheld by a drill are outside the main member list.

## 3. Surface visibility

Surfaces (Chronos deliverable inbox, mission-asset preview) list
**ArtifactRecords** (`active/shared/runtime/artifacts/<id>.json`), not
directories. A deliverable meant for people must be published:

```ts
writeScopedArtifact({
  scope: { mission: 'MSN-…' }, // or project / tenant + owner
  artifact_class: 'report',
  name: 'weekly/summary.md',
  content,
  publish: { kind: 'report', preview_text: 'Weekly summary' },
});
```

`publish` registers the record with the scope's tenant / project / mission
refs and `metadata.tier`, so the viewer scope (tenant + tier) is resolved
server-side. ArtifactRecords must have an owner (project, mission, or task
session); tenant- or system-scoped artifacts name it with
`publish.task_session_id`; an organization scope owns its record through
`organization_id`. Chronos `mission-asset` serves files under the artifact
floor, mission, project and organization trees, and derives tier / tenant from
the partition (system → public) or the `<tier>/<tenant>/` path segments.
The surface-facing record is written after the scoped artifact bytes, scope
index, and ownership append. A failed first publication can leave local
bytes and prior index writes. When a public-facing write reuses a logical
name with different bytes, the new body has a content-versioned path and
the old reference remains readable until publication. The scope index
records the content digest. Retrying the same publication with an explicit
artifact ID reuses its indexed version and unchanged ownership.
Publication validates its scope and existing owner before writing the body
or appending the index, including when an interrupted publication has an
ownership row but no surface record yet. Scoped and governed artifact writes
share the publication lock when they can reach a scoped path. They reject
ordinary overwrites and appends to previously published bodies.

### Mission → project promotion

When a mission linked to a project (`relationships.project`) finishes, its
published `report` / `export` scoped artifacts are **copied** into the project
(`<projectDir>/artifacts/<class>/missions/<MISSION_ID>/<name>`) and their
ArtifactRecords re-pointed there (`metadata.promoted_from`, `promoted_at`), so
the project keeps the deliverable after the mission is archived. Placement
follows the **project record** (its tier and tenant), and only a mission inside
that scope promotes (otherwise `reason: scope_mismatch`); the source must be a
regular file inside the mission's own `artifacts/` tree. The original
stays in the mission tree and moves to the archive with it; `evidence` stays
with the mission. Promotion is best-effort and idempotent
(`libs/core/mission/mission-artifact-promotion.ts`); the outcome is recorded in
the mission state `context.mission_artifact_promotion`.

### Organization digest

`core:organization_digest` with `persist: true` (on in
`pipelines/organization-daily-digest.json`) files each organization's entry as
a published report in that organization's own scope
(`…/<org>/artifacts/report/digests/<YYYY-MM-DD>.json`). The cross-tenant digest
itself is never stored as one file, so a tenant viewer only sees its own
organizations' digests. The standup and retro cadences (`core:organization_standup` /
`core:organization_retro`) file under `…/report/standups/` and
`…/report/retros/` the same way, their notifications land in the sovereign
operator inbox like the daily digest, and the pipeline context and trace carry
only counts and artifact paths — never the joined all-tenant text.

## 3a. Retention enforcement (storage janitor)

The storage janitor (`libs/core/storage/storage-janitor.ts`) applies
`knowledge/product/governance/storage-retention-catalog.json`. What it does,
by floor:

- **TTL precedence** is the same in every scanner: an explicit caller option
  (`scanTmp` `ttlMs`, `rotateLogs` / `sweepSupervisorEventFiles`
  `retentionDays`) > the catalog entry's `ttl_days` > the built-in default.
  In `rotateLogs` the option replaces only the logs-root TTL; a nested entry
  keeps its own `ttl_days` and action. The scheduled janitor passes no
  option, so the catalog decides.
- **Logs** are resolved per file to the longest-prefix catalog entry, so a
  nested entry overrides the logs root for its subtree. The shipped catalog
  deletes `active/shared/logs/**` after 30 days, but `active/shared/logs/audit`
  (`archive`, 90 days, audited) moves expired files to
  `active/archive/<repo-rel>`. A hash-chained audit day file
  (`logs/audit/audit-YYYY-MM-DD.jsonl`) and its tenant mirrors are expired
  together under the audit chain lock and are only ever archived or
  soft-deleted, never unlinked — an entry that would unlink one is reported
  as an error and the day stays live.
- **tmp**: files past the 1-day TTL are deleted, except that an unpromoted
  job directory holding authored code or ADF keeps its files
  `code_grace_days` (2) longer. During the grace the janitor warns with the
  exact `pnpm scratch:promote` command and lists the directory in
  `active/shared/runtime/system/scratch-promotion-candidates.json`
  (`libs/core/storage/scratch-promotion-grace.ts`).
- **Append-only stores** (`action: rotate`) roll to
  `<stem>-YYYYMMDD-HHmmss.jsonl` siblings, with `-<n>` appended on a
  same-second collision; only `.jsonl` live files are rotatable.
- **Audit first.** When an expiry must be audited (`audit: true`, archive,
  soft delete), the retention audit record is written
  before the file is moved or unlinked. If the record cannot be written, the
  file stays where it is and the next sweep retries. Every scanner lists such
  kept files in the janitor report's errors (`<scanner>: <path>: <why>`) and
  logs one summary warning per sweep. If the move or unlink fails after the
  record was written, a `RETENTION_EXPIRY_FAILED` record follows it. A file that
  is already gone when its expiry runs is skipped, not reported.
- **Legacy data vault.** Leftovers of the retired flat
  `active/shared/data-vault/` store are deleted 30 days after their last
  write, audited, by `scanLegacyDataVault` under the catalog's legacy entry
  (reported as `expiredDataVault` / `deletedDataVault`). Remove the sweep and
  the entry once deployments no longer hold the directory.
- **Fallback.** If the catalog is missing, corrupt or invalid, the janitor
  uses `BUILTIN_RETENTION_DEFAULTS` (`storage-retention-catalog.ts`) and
  reports `retentionCatalogSource: builtin-defaults`. The fallback copies the
  shipped catalog's rules for tmp (with the code grace), staging (3 days),
  the cache partitions (30 days; `cache/system/tool-runtimes`
  `review_required`), logs (30 days) with `logs/audit` archived at 90 days,
  the pre-catalog runtime TTLs and the legacy data vault (30 days, audited).
  It declares `active/audit` and
  `active/archive` `review_required`, with their nested system-ledger and
  trash entries. Everything else the catalog governs (other runtime and
  event-store entries, other append-only stores) is kept until the catalog
  loads again. Tests require every built-in entry to equal its shipped
  entry (every field except `note`, `backup` included), and every shipped
  entry nested under a built-in root to have such a twin, so the fallback
  never deletes more than the catalog would.

## 4. Migration status

- New code places data with this table; `sharedTmp()` call sites are frozen by
  `tests/shared-tmp-ratchet.test.ts` (ledger:
  `knowledge/product/governance/shared-tmp-allowlist.json`), and
  `active/shared/tmp` string literals in `pipelines/` are frozen by the same
  test's pipeline-literal ledger.
- `migrate-candidate` ledger entries are the work list. Priority: data that
  must outlive the 24h TTL (build trees, OAuth flows, reconcile registries,
  voice samples) → deliverables (move to `writeScopedArtifact` + `publish`) →
  inbound staging (perception CLIs).
- Legacy `outputs/` and `work/` at the repo root are outside this layout; new
  deliverables go to scoped artifacts instead.

## Store root registration and generation

`store-catalog.json` is the authoring source for registered state, ledger and
floor roots. Each registration declares its family, exported key, positive
family-local `order`, and effective retention-policy reference. Preserve order
when editing an existing registration: prefix classification and exported arrays
depend on it. Registrations describe placement; they do not grant access.
Fixed-tier stores such as the audit mirror retain `confidential/<tenant>` and
declare the matching singleton `tiers` value. Generation never widens that
binding into a generic `<tier>` location; missing or inconsistent fixed-tier
declarations fail validation.

Run `node --import ./scripts/ts-loader.mjs scripts/generate/generate_store_roots.ts`
after changing registrations. The generator validates the catalog and retention
references before replacing only the marked region in
`libs/core/foundation/runtime-state-roots.ts`. `storage-layout.ts` imports and
reexports those static definitions. No catalog is loaded by the runtime foundation.
The `store-roots` CI gate runs the generator with `--check`; the `store-catalog`
gate independently checks registration coverage. `resolve-generated` includes
the same generator, without a whole-file merge driver for the mixed source file.

## References

- `libs/core/storage-layout.ts` — floor resolver and classifier
- `libs/core/governance/owner-scope.ts` — owner-derived scope (`resolveOwnerScope`, `resolveMissionDir`)
- `libs/core/workforce/artifact-store.ts` — `writeScopedArtifact`
- `knowledge/product/governance/storage-retention-catalog.json` — TTLs
- `knowledge/product/governance/security-policy.json` — `tenant_scope`
- [multi-tenant-operations](./multi-tenant-operations.md) ·
  [entity-scope-hierarchy](./entity-scope-hierarchy.md) ·
  [project-mission-artifact-service-model](./project-mission-artifact-service-model.md)
