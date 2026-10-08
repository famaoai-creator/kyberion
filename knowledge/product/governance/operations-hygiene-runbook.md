---
title: 'Operations Hygiene Runbook: keeping fixed operational gaps fixed'
tags: [governance, operations, ci, retention, daemons, tests, recurrence-prevention]
last_updated: 2026-10-08
---

# Operations Hygiene Runbook

**Purpose.** Each section below covers one class of operational defect that was fixed at least once
and then came back. For each class it gives the rule, the procedure to follow when you touch that
area, and the automated check that enforces the rule. A defect class that recurs means its procedure
was missing or unenforced. Fix the defect, then extend this runbook or its gate in the same PR.

**Audience.** Anyone (human or agent) who changes CI workflows, runtime stores, daemons, child
processes, library logging, tests, or tenant-scoped facades.

**Origin.** MSN-OPS-GAPS-20261008 (organization `kyberion-ops`, project `PRJ-OPS-IMPROVEMENT`).
That mission closed 16 gaps from the 2026-10-08 operations survey. Several had been fixed before and
had regressed.

| Class                         | Gate / check                                                       | Section |
| ----------------------------- | ------------------------------------------------------------------ | ------- |
| CI workflow drift             | `ci-workflow-contract` (scope `pr`)                                | §1      |
| Undeclared runtime stores     | `runtime-store-retention` (scope `pr`), janitor `uncovered*` lists | §2      |
| Daemons and child processes   | unit tests per daemon; this checklist in review                    | §3      |
| stdout / logging in libraries | eslint `no-console` on `libs/`                                     | §4      |
| Test pollution and host deps  | Vitest leak guard, strict in CI (`KYBERION_TEST_LEAK_STRICT=1`)    | §5      |
| Tenant scope and facade env   | `tier-guard-tenant` tests, facade binding tests                    | §6      |

---

## §1 CI workflows

**Rules** (enforced by `scripts/check_ci_workflow_contract.ts`):

- Every job declares `timeout-minutes`. The default of 360 minutes lets a hung worker hold a runner
  for six hours. Size the timeout at about 1.5–2× the job's observed duration.
- Every `pull_request` workflow declares top-level
  `concurrency: { group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }} }`.
  Pushes to `main` and scheduled runs are never cancelled.
- Actions are pinned at or above their first Node 24 major (`MIN_ACTION_MAJORS` in the gate). When
  GitHub deprecates a runtime, raise the table first, then the workflows.
- A job never runs `pnpm --filter @agent/core build` before `pnpm run build`.
- Never interpolate untrusted event fields (`github.event.pull_request.title`, branch names, comment
  bodies) into a `run:` script. Pass them through `env:` and quote the variable; otherwise a crafted
  title runs shell commands.
- SHA-pinned actions carry their major in a trailing `# vN` comment; the gate reads it and rejects a
  SHA without one.

**Procedure when you add or change a workflow step:**

1. **One owner per suite on pull requests.** `pr-validation.yml` owns the PR run of core (sharded),
   actuators, boundary tests, lint, typecheck and format. Other workflows skip their copy on
   `pull_request` events at step level (`if: ... github.event_name != 'pull_request'`), so check
   names stay stable for branch protection. See `.github/workflows/README.md`.
2. **Do not depend on step order between workflows.** Example: a test that `mkdtemp`s under
   `active/shared/tmp/` must create that directory itself. Once cross-os stopped running the core
   shards first, such a test failed on CI.
3. **Grep `tests/` for pinned workflow text** (`grep -rn "actions/" tests`).
   `tests/workflow-operations-contract.test.ts` asserts parts of the workflows.
4. Run `pnpm check -- --only ci-workflow-contract` and the prettier format check over the workflow
   files.

## §2 Runtime stores and retention

**Rule.** Every path directly under `active/shared/runtime/` must have an entry in
`knowledge/product/governance/storage-retention-catalog.json` in the same PR that adds its writer.
This covers directories and top-level `*.jsonl` / `*.json` files.

**Procedure:**

1. **Pick the policy by what the store is.**
   - Evidence, logs and caches: `ttl_days` + `action: delete`. Add `audit: true` for evidence.
   - Load-bearing state (registries, consumed-key ledgers, queues, keys): `action: review_required`.
   - A self-bounded file: no `ttl_days`, and the `note` names the mechanism that bounds it.
2. **Write the note.** Cite the writer module and say why the store is safe to delete or must never
   be deleted. The janitor's mtime TTL walks only directories. A top-level append-only ledger
   therefore needs a self-bounding writer or `review_required`.
3. **Never re-read a growing ledger in full on a hot path.** Use `readJsonLinesCached`
   (`libs/core/jsonl-tail.ts`), which parses only bytes appended since the last call and replays on
   rotation or rewrite. Its rows are frozen and shared across calls: never mutate them. Do not prune a ledger whose rows mean "consumed forever" (for example the
   dot wake ledger); pruning it re-fires old wakes.
4. **Run `pnpm check -- --only runtime-store-retention`** (part of `--scope pr`). It fails with
   `file:line` for any literal runtime path that has no entry. Add a file-scoped exemption, with a
   reason, in `scripts/check_runtime_store_retention.ts` only for strings that are not real stores.
5. **Check the janitor report.** `uncoveredRuntimeDirs` / `uncoveredRuntimeFiles` must not list the
   new name. A name there means a store was created through a dynamic path the gate cannot see; add
   its catalog entry by hand.

## §3 Daemons and child processes

**Daemon contract.** This applies to every long-running loop: scheduler, supervisor,
generation-schedule, bridges.

- **No overlapping ticks.** Use a self-rescheduling `setTimeout` loop with an in-flight flag, not an
  async `setInterval`.
- **Handle `SIGTERM` and `SIGINT`.** Stop the timer, wait for the in-flight tick (bounded), release
  any leader or lease lock, record a `stopped` heartbeat, and exit 0. The reference implementation
  is `scripts/agent_runtime_supervisor_daemon.ts`.
- **A shutdown is not a failure.** A child that exits because the daemon forwarded `SIGTERM` during
  shutdown must not raise an ops alert or an `error` heartbeat; mark the shutdown and report the
  tick as cancelled.
- **Never hand a lease over while work still runs.** If the in-flight tick did not drain in time,
  release the leader lease only immediately before exiting, never while the abandoned tick can
  still act (a second leader would double-run schedules).
- **Give every child a deadline.** Kill the child when it expires, raise an ops alert via
  `sendOpsAlert`, and forward signals to the child on shutdown.

**Child-process contract:**

- Prefer the `secure-io` exec helpers (`safeExec*`, default timeout 30 s).
- When raw `spawn`/`spawnSync` is unavoidable (stdin piping, streaming), always pass a `timeout` or
  arm a kill timer. Always attach an `'error'` listener: an `ENOENT` without one crashes the process.
- Probes of external CLIs (`--version`, keychain, osascript) are bounded at about 10 s. Report a
  timeout as "unavailable (timed out)", never as a hang.

**Review checklist** (when a PR adds a loop or a spawn): in-flight guard, signal handlers, stopped
heartbeat, child deadline, `'error'` listener, test with a mocked child.

## §4 stdout and logging in library code

**Rules:**

- Library code (`libs/**`, non-test) never writes to stdout. stdout belongs to the CLI and is often
  JSON that a pipeline parses.
- Library code returns data. The CLI renders human output. Diagnostics go through `logger` /
  `createLogger`, which writes to stderr and the per-process log file
  ([logging-policy](./logging-policy.md)).
- `console.*` in libraries bypasses the log file sink. The eslint `no-console` rule enforces this
  for `libs/`; a justified exception needs an inline disable with a reason.

**Procedure.** If a function used to print a table, make it return rows. Then let the CLI that calls
it (for example `mission_controller`) print them, and check every pipeline op that calls it still
gets clean JSON.

## §5 Tests: pollution and host dependencies

**Rules** (details in [WRITING_TESTS](../../../docs/developer/WRITING_TESTS.md)):

- Tests never write live `active/` state. CI runs the leak guard in strict mode
  (`KYBERION_TEST_LEAK_STRICT=1`, forwarded to the Vitest child by `pnpm test`). Any created or
  grown file outside the sandbox roots fails the job.
- Tests that need a host binary (sqlite3 with FTS5, a CJK font, poppler, LibreOffice) skip when it is
  absent. Gate them with the owning module's probe (`probeHistorySearchBackend()`,
  `pickCjkFontSource()`, `detectRasterCapabilities()`), and make sure the CI workflows install the
  binary so coverage is kept.

**Procedure when the leak guard reports a file** (`active/shared/tmp/vitest-active-leaks.json`):

1. **Written through `pathResolver.shared()` / `rootResolve()`:** add the sub-path to
   `VITEST_LIVE_SUBTREES` (`libs/core/path-resolver.ts`) and assert the mapping in
   `path-resolver.test.ts`.
2. **Hand-built path:** route it through `pathResolver` or `vitestLivePath`.
3. **Lock or one-off file:** fix it at the test. Release the lock, or use `sharedTmp`.
4. **"Created" on CI but not locally:** a fresh checkout shows files a dev tree hides, because a
   rewrite that does not grow a file is not reported. Reproduce by deleting the file and re-running
   the suspect suite.

## §6 Tenant scope and governed facades

**Rules:**

- **Registry paths are not tenants — but are not shared either.** The tenant classifier
  (`checkTenantScope` in `libs/core/tier-guard.ts`) reads the first segment under a protected prefix
  as a tenant slug, so a registry or index file there (for example
  `knowledge/confidential/tenants/index.json`) is denied to tenant-bound contexts. Do **not** fix
  that by adding the file to `security-policy.json` `tenant_scope.shared_prefixes`: shared prefixes
  bypass tenant scope for reads **and writes**, which would let any tenant read every slug and
  rewrite other tenants' entries (deny-unless-brokered). Read such a file through a governed
  system-scope reader (the pattern of `check_tenant_registry_consistency`'s read grant), and write it
  only through a governed store-writer.
- **Facades carry their own binding.** A governed facade binds the tenant and organization it was
  given (`--tenant-slug`, `--organization-id`) via
  `withExecutionContext(role, fn, undefined, tenantSlug, organizationId)`. An operator must never
  need `KYBERION_TENANT` for one subcommand of a facade but not for another.
- **Validate under the caller's authority.** Registry reads that validate a caller's input
  (tenant registered, active) run under the caller's authority before entering a narrow
  internal-role fence such as `withExecutionContext('infrastructure_sentinel', …)`. Run inside the
  fence, they fail with `ROLE_VIOLATION` on `knowledge/personal/tenants/`.

**Procedure:**

1. When you see `tenant.scope_violation … tenant '<x>'` and `<x>` is a registry directory, route
   the read through a governed system-scope reader instead of widening the policy. Add a
   `tier-guard-tenant.test.ts` case proving a tenant-bound context still cannot write (or, unless
   brokered, read) the file.
2. Verify onboarding-flow commands with the real CLI in a throwaway worktree.
   - Create the throwaway company with `pnpm onboarding company … --slug probe-co --tenant-slug probe-co`.
   - Then run `tenant:activation plan|probe` and `work create-item` with `KYBERION_CUSTOMER`,
     `KYBERION_TENANT_SCOPE_REQUIRED=true` and `KYBERION_PERSONA=sovereign`.
   - Remove the throwaway state afterwards: `customer/`, `knowledge/personal/tenants/`,
     `knowledge/confidential/`, `active/organizations/`.

---

## Maintenance

When a defect class not listed here recurs:

1. Add a section with the rule, the procedure, and the gate or test that enforces it.
2. Link the section from [kyberion-development-practices](./kyberion-development-practices.md) and
   the pre-PR checklist.
3. Record the incident in the mission's retrospective.

A rule without an enforcing check is a candidate for the next gate.
