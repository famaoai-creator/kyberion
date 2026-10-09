---
title: 'Operations Hygiene Runbook: keeping fixed operational gaps fixed'
tags: [governance, operations, ci, retention, daemons, tests, recurrence-prevention]
last_updated: 2026-10-09
---

# Operations Hygiene Runbook

**Purpose.** Each section below covers one class of operational defect that was fixed at least once
and then came back. For each class it gives the rule, the procedure to follow when you touch that
area, and the automated check that enforces the rule. A defect class that recurs means its procedure
was missing or unenforced. Fix the defect, then extend this runbook or its gate in the same PR.

**Audience.** Anyone (human or agent) who changes CI workflows, runtime stores, daemons, child
processes, library logging, tests, tenant-scoped facades, LLM/provider calls, generators that
write mission evidence, or project lifecycle commands.

**Origin.** MSN-OPS-GAPS-20261008 (organization `kyberion-ops`, project `PRJ-OPS-IMPROVEMENT`).
That mission closed 16 gaps from the 2026-10-08 operations survey. Several had been fixed before and
had regressed.

| Class                         | Gate / check                                                          | Section |
| ----------------------------- | --------------------------------------------------------------------- | ------- |
| CI workflow drift             | `ci-workflow-contract` (scope `pr`)                                   | §1      |
| Undeclared runtime stores     | `runtime-store-retention` (scope `pr`), janitor `uncovered*` lists    | §2      |
| Daemons and child processes   | unit tests per daemon; this checklist in review                       | §3      |
| stdout / logging in libraries | eslint `no-console` on `libs/`                                        | §4      |
| Test pollution and host deps  | Vitest leak guard, strict in CI (`KYBERION_TEST_LEAK_STRICT=1`)       | §5      |
| Tenant scope and facade env   | `tier-guard-tenant` tests, facade binding tests                       | §6      |
| LLM / provider calls          | per-call-site egress tests (e.g. `mission-distill-egress.test.ts`)    | §7      |
| Mission evidence overwrites   | generator and phase-pipeline tests in `mission-retrospective.test.ts` | §8      |
| Project lifecycle facades     | lifecycle regressions in `project-management.test.ts`                 | §9      |

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

**Gate budgets (`pnpm check`).** `scripts/run_checks.ts` runs up to 6 gates at once with a 120s
default per gate (`DEFAULT_GATE_TIMEOUT_MS`). A gate that times out on busy runs:

1. Time it alone and under the concurrent run, and profile it (`node --cpu-prof`). Make it faster
   first, and measure each optimisation separately, comparing CPU time across alternating runs in
   separate processes. Wall time on a shared host is too noisy. Example: `role-assumption-reachability`
   saved about 20% of its CPU (~41s to ~32s) by memoising workspace lookups, with a byte-identical
   report. A member-name prefilter looked faster in one wall-clock run but saved nothing in CPU, so it
   was dropped rather than kept as unproven soundness risk in a security gate.
2. If it still needs more time, give that gate a `timeout_ms` in `ci-gates.json` and state the
   measurement in its rationale (`Budget: …`). Do not raise the global default.
   `scripts/run_checks.test.ts` pins the default and the role-assumption budget.
3. Prove the gate still fails on a stale or broken input after the speed-up.
4. A pruning optimisation that a gate's verdict depends on needs a switch that turns it off, plus a
   differential test that compares the output with the switch on and off over fixtures for every
   case the pruning reasons about.

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
- Do not re-import the secure-io / tier-guard / authority stack in every test with
  `vi.resetModules()`. Set `KYBERION_ROOT` and the role env first, import once per file in
  `beforeAll`, and reset per-test state through the module's own hooks
  (`resetRoleAssumptionPolicyCache()`, rewriting the fixture file). Each re-import repeats all
  module-level initialisation of that stack, and the pattern has crashed macOS Vitest workers
  with SIGSEGV (`stimuli-journal-rotation-role.test.ts`, 2026-10). Keep `vi.resetModules()` for
  the tests that need a fresh instance, for example after `vi.doMock`. Import a heavy stack in
  `beforeAll` with an explicit hook timeout (e.g. `60_000`) so its one-time load is not charged
  to the first test's 10s budget ([WRITING_TESTS](../../../docs/developer/WRITING_TESTS.md#fixture-roots)
  lists the accepted exceptions).
- A test must not depend on load or order. Run a suspect file with
  `--sequence.shuffle --sequence.seed=<n>` (at least 222, 7 and 20261008) and under parallel load
  before calling it fixed. Four defect classes caused the 2026-10 load and order failures:
  - **A real child process for code the test could call in process.** A spawned
    `node --import ts-loader.mjs scripts/x.ts` or `dist/...` CLI spends seconds on start-up
    (transpiling, loading the core stack, re-reading the 290KB `libs/core/package.json` for every
    module) and almost nothing on the behaviour under test. Call the script's exported
    `main(argv, print)` / render function after a `beforeAll` import instead. Keep a child only when
    the CLI process itself is the subject (an end-to-end suite). Then pass
    `KYBERION_REASONING_BACKEND=stub` so the child does not probe the host's provider CLIs, and pass
    an explicit `timeoutMs` sized from a measurement under load, with the measurement in a comment.
  - **Hidden real work behind a mocked edge.** `recordMissionContextTask` spawned
    `mission_controller record-task` per dispatch, and the first dispatch installed the real
    reasoning and STT backends, probing every `python3.x` and `claude auth status`. Both happened
    although the transport was mocked. Mock them at the module seam.
  - **Abandoned async work after a timeout.** Vitest does not cancel a timed-out test. Its dispatch
    keeps calling mocks and writing the fixture while the next test runs. A module-registry reset
    racing such an in-flight import evaluated a module twice against one seam port
    (`SeamError: Provider mission-worker-core is already registered`). Track the promises a test
    starts and `await Promise.allSettled(...)` them in `afterEach` (with an explicit hook timeout)
    before cleanup. A module-level seam registration must be safe to re-evaluate
    (part-core registers with an unexported `replaceKey`; a supersede logs a warning).
  - **A per-test mock that reaches a cached catalog.** `safeExistsSync.mockReturnValue(false)`,
    meant for one artifact, also answered the media-backend registry's directory check. The test
    passed only when an earlier test had already cached the registry. Route governed catalog paths
    (`knowledge/product/`) to the real implementation inside the mock.

**Procedure when the leak guard reports a file** (`active/shared/tmp/vitest-active-leaks.json`):

1. **Written through `pathResolver.shared()` / `rootResolve()`:** add the sub-path to
   `VITEST_LIVE_SUBTREES` (`libs/core/path-resolver.ts`) and assert the mapping in
   `path-resolver.test.ts`. A live store outside `active/` (e.g. the `work/metrics/`
   execution-metrics / resource-usage ledgers) goes in `VITEST_LIVE_REPO_SUBTREES` instead, and
   its root in the leak guard's `LIVE_STATE_ROOTS`.
2. **Hand-built path:** route it through `pathResolver` or `vitestLivePath`.
3. **Lock or one-off file:** fix it at the test. Release the lock, or use `sharedTmp`.
4. **"Created" on CI but not locally:** a fresh checkout shows files a dev tree hides, because a
   rewrite that does not grow a file is not reported. Reproduce by deleting the file and re-running
   the suspect suite.
5. **Reported only on CI, even from a fresh tree:** CI runs with a different identity. Reproduce
   with the CI environment, not your shell's:
   `KYBERION_PERSONA=worker MISSION_ROLE=mission_controller KYBERION_TEST_LEAK_STRICT=1 pnpm test -- --suite core`.
   Persona-dependent code paths (stores that only persist for some roles, default-tenant bootstrap)
   diverge between the two. Platform-only code paths (for example the macOS Apple FM bridge compiling
   into `active/shared/runtime/apple-intelligence/`) leak only on that OS's runner; read the
   leak report of every matrix leg, not just Linux.
6. **A suite must write a live registry** (tenant index, trust ledger, design index): snapshot it in
   `beforeAll` and restore it in `afterAll` through one fixture helper, so a failing test cannot
   leave the registry changed for the next suite.

**Procedure when a test times out only under load or in a shuffled order:**

1. Reproduce: run the file alone, then with `--sequence.shuffle --sequence.seed=<n>`, then under
   synthetic load (busy-looping `node -e 'for(;;){}'` processes, 3x the core count, while the file
   runs).
2. Measure where the time goes before changing anything. Profile the Vitest worker with
   `--execArgv=--cpu-prof --execArgv=--cpu-prof-dir=<dir>`, and log every `spawnSync` /
   `execFileSync` with its caller (a `--require` preload in `NODE_OPTIONS` that wraps
   `node:child_process` and calls `syncBuiltinESMExports()`). Large `(idle)` time in the worker
   means it is waiting on a child or on transforms.
3. Fix the cause (the four classes above). Raise a timeout only for work that is legitimately heavy,
   such as a cold stack import in `beforeAll` or a real CLI end-to-end suite, and record the
   measurement next to it.
4. Force a timeout (`--testTimeout=<small>`) and check that only the timed-out test fails.

Writers and readers of the same file must resolve the path the same way. A reader through
`pathResolver.shared()` and a writer through `path.join(rootDir, …)` diverge under the sandbox:
the test passes against the sandbox while the writer leaks into live state.

**Real-process tests: size the budget from the child count.** A test that spawns
`node --import ./scripts/ts-loader.mjs` children pays a cold start per child: the loader transpiles
every imported `libs/core` source again (about 5s of CPU per child, 10s on a loaded 4-vCPU host).
`front-desk-recovery.engine.integration.test.ts` runs up to 17 sequential child batches. Its 180s
local budget failed on a busy host while CI (`CI=true`, 600s) stayed green.

- Bound each child with its own timer, using the same value locally and on CI.
- Size each test's timeout from its sequential child batches at the loaded per-batch cost
  (`engineTestBudget(batches)`). Use the same value locally and on CI, not a flat local constant.
- In `afterAll`, stop the children and wait for `'exit'`, not `'close'`, because a grandchild can
  hold the pipes. Bound the wait with a grace period, then send SIGKILL to any survivor. Remove the
  fixture roots in a `finally` block, and give the hook an explicit timeout.

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
  fence, they fail with `ROLE_VIOLATION` on `knowledge/personal/tenants/`. Validate on creation and
  whenever an update changes the tenant; a plain re-sync of an existing item does not re-validate,
  so suspending a tenant does not strand its imported items.
- **Tier data outside `knowledge/` keeps the knowledge tier's read rules.** A runtime ledger that
  holds tenant or personal/confidential rows is partitioned
  `active/shared/runtime/<ledger>/<tier>/<tenant|shared>/`, never appended to a repo-wide file.
  Register its root in `PARTITIONED_RUNTIME_LEDGER_ROOTS` (`libs/core/storage-layout.ts`) and its
  `<root>/{personal,confidential}/` prefixes in `tenant_scope.protected_prefixes`. Tier-guard then
  applies the tenant check **and** the persona decision of `knowledge/<tier>/` to every read
  (`personaTierReadDecision`) — never a second persona table. Aggregate readers skip a denied
  partition with a diagnostic `debug` line instead of failing. Reuse the metrics ledgers'
  `PartitionedMetricsLedger` and the offboarding `METRICS_LEDGERS` table
  (`libs/core/scope-offboarding.ts`: export, approval-gated legacy-row prune, audit) instead of a
  new mechanism.
- **A read gate never weakens a cap.** A cap or limit enforcer reads gated ledgers only through
  `aggregateMetricsForEnforcement` (`libs/core/metrics.ts`; governed read-only role
  `metrics_cap_reader`, numbers only), never through a row reader, so a persona that may not read
  the rows still has its spend counted. A report or summary built from a gated read passes
  `onWithheld` and shows `metricsWithheldNotice` (one diagnostic warn + a "partial" line in its
  output). Gate: `libs/core/metrics-enforcement-aggregate.test.ts`.
- **Caps are evaluated where they are read.** A tenant-bound process evaluates spend caps per
  bound tenant — policy (`spend-policy.json` `tenant_overrides`) and ledgers from the same
  tenant — and ignores (debug-logs) a different requested tenant instead of mixing them; it never
  refuses one, because tenant authorization is the scope layer's job (brokered missions, warn
  posture). An unbound process evaluates the requested tenant, else globally. Compare slugs
  trimmed and lower-cased. Any enforcement cache is keyed by tenant/day/mission, bounded, and kept
  current by adding the process's own costed appends (zero-cost rows never invalidate it); only an
  unattributable costed row invalidates. A budget evaluated over a scope wider
  than what the process could read is `cost_status: 'partial'` with `withheld_partitions`.
- **Never rewrite a hot ledger from a stale plan.** A prune of an append-only ledger (tenant
  offboarding) recomputes, exports and rewrites under the same lock its appenders take
  (`metricsLedgerLockId` + `withLockSync`); a plan computed earlier only sizes the dry run.
- **Evidence stays in the tenant's scope.** A per-tenant command (activation probe, readiness
  report) that runs a repository-wide check keeps only the lines about its own tenant in the
  evidence it writes, and points at the repository-wide command for the rest.

**Procedure:**

1. When you see `tenant.scope_violation … tenant '<x>'` and `<x>` is a registry directory, route
   the read through a governed system-scope reader instead of widening the policy. Add a
   `tier-guard-tenant.test.ts` case proving a tenant-bound context still cannot write (or, unless
   brokered, read) the file.
2. When a store moves tenant rows out of a shared file, find every reader first
   (`grep` the loader, e.g. `loadHistory(` / `loadResourceUsageHistory(`) and give each an explicit
   read scope; a reader left on the default silently loses the tenant rows it used to see. Prove the
   gate with the real tier-guard (pattern: `libs/core/metrics-ledger-persona-gate.test.ts` — one
   persona allowed, one denied, aggregate read skips instead of throwing) and add a
   `scope-offboarding.test.ts` case for the purge.
3. Verify onboarding-flow commands with the real CLI in a throwaway worktree.
   - Create the throwaway company with `pnpm onboarding company … --slug probe-co --tenant-slug probe-co`.
   - Then run `tenant:activation plan|probe` and `work create-item` with `KYBERION_CUSTOMER`,
     `KYBERION_TENANT_SCOPE_REQUIRED=true` and `KYBERION_PERSONA=sovereign`.
   - Remove the throwaway state afterwards: `customer/`, `knowledge/personal/tenants/`,
     `knowledge/confidential/`, `active/organizations/`.

---

## §7 LLM and provider calls

**Rules:**

- **Check provider egress for the data tier before every send.** Any path that hands mission or
  tenant content to an LLM provider (CLI or API) first calls `checkProviderEgress` (provider, data
  tier, tenant) from `libs/core/provider/provider-egress-gate.ts` for each candidate provider.
  - Identify the provider that actually receives the prompt: for a shell-run profile that is the
    command, not the adapter name. An unknown provider, or an adapter and command naming different
    providers, is denied above `public`.
  - An omitted data tier is treated as `confidential` (fail closed). Callers with public content
    say so explicitly.
  - Skip a denied provider and degrade (next provider, or a no-LLM path). Do not add
    `approved_providers` exceptions to make a call site work.
  - To enable LLM work on confidential/personal material for a tenant, the operator attests the
    provider's plan explicitly with `pnpm onboarding llm attest` (`--training-use none` plus
    `--plan`, `--basis`, `--attested-by`). Because `none` opens confidential egress it needs a
    human approval: `--request-approval` opens a hash-bound request, a human runs
    `pnpm kyberion approvals --approve <id>`, then the same command with `--apply`, `--accept`
    and `--approval-request-id <id>` records it once. `used`/`unknown` never open egress and need only
    `--apply --accept`. `pnpm tenant attest-provider` follows the same rules, store and audit
    action (`tenant.attest_provider`, with actor and approver). Never attest or approve on the
    operator's behalf. `pnpm onboarding llm show --tenant <slug>` and `tenant:activation plan`
    (`llm_availability`) show which providers each tier can use. See
    [onboarding-flow Step 5.1](./onboarding-flow.md).
  - The `--request-approval` output prints the apply command for POSIX shells (sh, bash, zsh)
    with every bound value (plan, basis, attested-by, valid-for-days) quoted, so it applies
    as-is when pasted. A printed follow-up command for a hash-bound approval must never elide
    a bound value (`...`): build it from `providerAttestationApplyArgs` + `shellQuoteArg` in
    `tenant-governance.ts`, and reject values with a backslash or control characters at parse
    time (`assertPrintableCommandValue`).
  - In `libs/core/mission/mission-llm.ts`, `runAdaptiveStructuredLlmProfile`,
    `runStructuredLlmProfile` and `invokeLlm` all take an `egress` option and apply this gate;
    `mission distill` passes the mission tier and tenant.
- **Separation of duties is opt-in and enforced in two places.** By default the requester may
  approve their own request. With `separation_of_duties.enabled: true` in `approval-policy.json`
  (or the customer overlay; global, not per tenant or organization):
  - `decideApprovalRequest` refuses an approval whose decider equals a recorded requester, a
    request without a requester, an empty or placeholder decider (`APPROVAL_PLACEHOLDER_DECIDERS`),
    and a decider the surface took from its caller (`deciderIdentitySource: 'caller_supplied'`).
    Refusals are audited (`separation_of_duties` / `denied`). A surface whose token proves only
    possession (the mission brief page) resolves the decider server-side.
  - Every consumer that turns an approved record into an effect checks it first under a consumer
    id (`assertApprovalUsable` / `approvalUsabilityRefusal`); the registry is
    `libs/core/governance/approval-sod-consumers.contract.test.ts`. A decision recorded while
    the setting was off cannot take effect after it is on, and re-request helpers never hand back
    such a record.
  - An unreadable `approval-policy.json` blocks approving decisions and approval use even with
    the setting off (fail closed, diagnostic message); only plugin activation degrades to
    `pending_approval` with a warning.
  - Known limits (string identities, the CLI persona-vs-name gap, policy/service deciders, flows
    outside the approval store such as `service_recording review`) are listed in
    [approval-gate-design](./approval-gate-design.md).
- **Prompts and secrets go on stdin, never argv.** argv is visible in the process table and is capped
  at about 128 KB per argument. Shell-invoked LLM profiles use `prompt_via: "stdin"` (the `claude`
  profile in `wisdom-policy.json` does), and the system prompt travels on stdin with the prompt.
  The same applies to passwords and tokens for any CLI.
- **Provider CLIs run tool-less from a scratch cwd.** A model that passed the gate for one payload
  must not be able to read other files. Run provider CLIs for one-shot answers with tools disabled
  and a single turn (for `claude`, the flags of the `claude` profile in `wisdom-policy.json`:
  `--max-turns 1`, `--tools ""`, `--strict-mcp-config`, `--setting-sources=`,
  `--disable-slash-commands`, `--no-session-persistence`), and start them in an
  empty directory on the scratch floor (`active/shared/tmp/system/<domain>/`), not the repository
  root.
  - The dedicated `codex-cli` and `gemini-cli` structured runners in `mission-llm.ts` do the same.
    They request the KD-05 `explorer` projection from the provider descriptors
    (`reasoning-providers/*.json` `permission_profiles`): codex `--sandbox read-only` and gemini
    `--sandbox --approval-mode plan`. They start in `llmShellScratchCwd()`, and the prompt goes on
    stdin (codex `exec … -`; gemini gets a fixed `-p` instruction that the CLI appends to stdin).
    Other callers of `runCodexCliQuery` / `runGeminiCliQuery` keep their own mode.
  - The runners forward only `bin`, `model` and `timeout_ms` from a policy profile. Once a
    permission profile is set, `runCodexCliQuery` / `runGeminiCliQuery` also drop caller
    `extraArgs` that would widen it (sandbox, approval, yolo, `--dangerously-*`, `--add-dir`,
    `-c sandbox*|approval_policy*`). Do not forward a whole profile object as CLI options.
  - **Residual risk:** neither CLI can switch its tools off the way `claude --tools ""` does.
    - Codex `read-only` still lets the model run read-only shell commands. Its sandbox does not
      limit reads to the cwd, and the scratch cwd is inside the checkout, so codex can still find
      the repository's `AGENTS.md`. This is why the descriptor refuses codex for the `planner` tier.
    - Gemini plan mode keeps read-only tools. `--sandbox` confines them to a container or Seatbelt
      profile, so on a host without one the runner fails, and `mission-llm` falls back to the next
      profile.
    - Gemini stdin covers only the process Kyberion spawns. With `--sandbox`, the gemini launcher
      may re-spawn itself inside the sandbox and re-inject the stdin it read into that child's `-p`
      argv. This is not verified here; treat the prompt as possibly visible in the sandbox's
      process table.
    - A gemini build that ignores piped stdin sees only the fixed instruction. The strict schema
      then fails, so the call fails closed and `mission-llm` moves on to the next profile.
    - For tenant-tier payloads, rely on the egress gate and prefer the `claude` profile.

**Procedure:**

1. When you add a call site that sends content to a provider, derive the tier from the content's
   source (mission `state.tier`, `highestTierForPaths` for knowledge paths) and gate it as above.
2. Add a test that fails without the gate: a confidential payload with only a non-attested provider
   must not invoke it, and a public payload still does. Mock `../ops-alert.js` so denials do not
   write to the shared ops-alert sink.
3. For a new provider CLI invocation, assert in a test that argv carries the tool-disabling flags
   and no prompt text, and that the child's cwd is not the repository root.
4. When a CLI prints a follow-up command for a hash-bound approval, test that the printed text,
   split as a POSIX shell would, applies successfully once the request is approved (gate:
   `scripts/onboarding_llm.test.ts` and `scripts/tenant.entrypoint.test.ts`).
5. When you add an approval request creator, record the real requester identity in
   `requestedBy` (and `requestedByContext.actorId`), never an empty string: with separation of
   duties on, a request without a requester cannot be approved (gate:
   `libs/core/governance/approval-separation-of-duties.test.ts`).
6. When you add code that turns an approved record into an effect, call
   `assertApprovalUsable(record, { consumer })` before the effect. When you add a decision surface
   that takes the decider from its caller instead of a resolved session, pass
   `deciderIdentitySource: 'caller_supplied'`; when it falls back to a placeholder decider id,
   add that id to `APPROVAL_PLACEHOLDER_DECIDERS` (gates: approval-separation-of-duties.test.ts,
   `approval-actuator-sod.test.ts`).

**Profile timeouts are hard limits.** Since #1006 the codex/gemini structured runners honour a
profile's `timeout_ms`; before that they used their 5-minute adapter default. A timeout is not a
quota error, so `runAdaptiveStructuredLlmProfile` does not fall through to the next profile: the
call fails.

- Size `timeout_ms` for a full provider CLI turn, not for the model's answer alone. A `codex exec`
  turn includes process start, sandbox setup and the user's default model and effort. The only
  in-repo latency figure (4.3s, `realtime-media-session-architecture.md`) is for a one-sentence
  reply on a fast model at `low` effort, which the wisdom profiles do not request.
- `wisdom-policy.json` profiles stay between the 120s built-in fallback and 300s. The codex `light`
  profile (summarize, classify) was 30s and is now 120s, the same as `standard` (gemini) and
  `BUILTIN_FALLBACK`. `heavy` (codex) and `claude` stay at 180s for distillation.
  `mission-llm.test.ts` enforces this range for provider-CLI adapters (`codex-cli`, `gemini-cli`,
  `claude-cli`). A profile without `timeout_ms` counts as its runtime default (300s for the
  codex/gemini runners, 120s for the shell runner). Going above the 300s ceiling needs a recorded
  justification in that test.
- These limits suit batch callers. Today the only production caller is `mission distill`
  (`runAdaptiveStructuredLlmProfile('distill', ...)`, run by `mission_controller`). No interactive
  or surface path calls a wisdom profile synchronously. Such a caller must set its own shorter
  timeout rather than rely on the profile value.

---

## §8 Mission evidence: generated files and recorded deliverables

**Rule:** a generator never writes to a path that a task records as its deliverable. Generated
artifacts (stats, reports, manifests written by `finish`, `verify`, dispatch or any other automatic
step) get their own file names.

- A task's `deliverable` path (from `mission-workflow-catalog.json` and the other workflow
  templates) belongs to whoever records it with `record-evidence`. Writing it from a generator
  silently replaces recorded evidence.
- A generator also does not create a deliverable path when the file is absent. Task
  auto-completion trusts the existence of the deliverable (`tryAutoCompleteTaskFromEvidence`), so a
  generated placeholder would close a task that nobody did.
- Example: `mission finish` runs the retrospective generator. It writes
  `evidence/retrospective-stats.md` and `evidence/retrospective.json`. It never writes
  `evidence/retrospective.md`, which is the hand-written deliverable of the retrospective task
  (MSN-OPS-ROUND3-20261008).
- Pipeline templates count as generators. The `pipeline_ref` template of a `judgment`, `review` or
  `approval` phase may read evidence, but must not target that phase's deliverable. Only a
  `deterministic` phase's deliverable is the pipeline's own output. Resolve mission paths through
  the engine-derived `{{mission_evidence_dir}}`, never a hand-built `active/missions/{{mission_id}}`
  (which skips the tier directory). Example: `post-release-retrospective` writes
  `evidence/retrospective-packet.md`, not `evidence/retrospective.md`.

**Procedure:**

1. When you add or change a write under a mission's `evidence/`, grep the workflow templates for
   the path (`grep -rn '"deliverable": "evidence/<name>"' knowledge/product/`). If a template
   declares it, pick a different name.
2. Add a test that fails if the generator overwrites the path: seed a hand-written file at the
   deliverable path, run the generator, and assert the file is byte-identical and that the
   generated output is in its own file. Also assert that the generated path is not a declared
   deliverable (pattern: `mission-retrospective.test.ts`). The same file checks every
   non-deterministic phase's `pipeline_ref` template against the phase's deliverables; keep it
   green when you add or edit a phase pipeline.
3. Update every reader and link of a renamed generated file in the same PR: `report_path`
   consumers, `notifyOperator` `link_hint`, phase docs and playbooks.

---

## §9 Project lifecycle facade parity

**Rule.** Dedicated lifecycle commands and generic status updates must execute the
same guarded facade. Archive checks live missions, task sessions and unfinished
tracks before changing ownership projections. Leaving archived state requires an
explicit restore operation.

**Procedure.** When changing project or track statuses, update the CLI and typed
facade together, reconcile operational state and default track membership, and
preserve rollback and audit behavior. Verify descriptive edits do not implicitly
restore archived records.

**Gate.** Run the focused lifecycle regressions in
`libs/core/project/project-management.test.ts` and build core plus the repo CLI.
These cover archive entry-point parity, restore, and track state/projection changes.

---

## Maintenance

When a defect class not listed here recurs:

1. Add a section with the rule, the procedure, and the gate or test that enforces it.
2. Link the section from [kyberion-development-practices](./kyberion-development-practices.md) and
   the pre-PR checklist.
3. Record the incident in the mission's retrospective.

A rule without an enforcing check is a candidate for the next gate.
