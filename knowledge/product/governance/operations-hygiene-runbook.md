---
title: 'Operations Hygiene Runbook: keeping fixed operational gaps fixed'
tags:
  [governance, operations, ci, retention, daemons, tests, recurrence-prevention, secure-io, symlink]
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
| secure-io link escapes        | `secure-io.symlink-canonical.test.ts`, `secure-io.symlink-root-alias` | §10     |
| Actuator failure receipts     | cli-utils / actuator tests, `pty-engine.resize.test.ts`, probes       | §11     |

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

**Surface result receipts.** A zero exit code or a human-readable success marker is not proof of
completion. Before projecting a child result into a user-facing success or duplicate status,
validate one complete, phase-appropriate structured receipt and correlate its destination and
source with the request. Reject conflicting verdicts, incomplete JSON and mismatched provenance.
For document ingest, exercise the parser and API together (`ingest-output-parser.test.ts`,
`ingest-result-route.test.ts`), including genuine duplicate and superseding receipts. Invalid
post-write receipts must stay uncertain (HTTP 502), never become a pre-execution rejection or
trigger an automatic retry; keep the interrupted/repeated-flow tests in `ingest-ui.test.ts`.

**Settings read-edit-save ownership.** Defaults are not saved preferences. A pane must wait for a
complete successful read before enabling editing or saving; loading failures need an explicit
read-only retry. Keep one request owner, cancel on unmount, and bind the loaded draft to the
current sign-in context. Freeze controls during saving and show success only when the complete
response matches the submitted snapshot. Clear success on a later edit. A definitive pre-write
validation rejection leaves the draft correctable; a lost or unverified write result requires
reading saved state before another write, never an automatic write retry. Preserve saved choices
that do not map to a simplified preset. For quiet hours, run `quiet-hours-view.test.ts` and
`quiet-hours-ui.test.ts` alongside the notification-preferences API tests, covering failed and
malformed reads, delayed replies, reload, repeated clicks, sign-in changes, unmount, explicit
validation rejection, malformed/mismatched saved receipts and overnight/timezone values.

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
  before calling it fixed. Five defect classes caused the 2026-10 load and order failures:
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
    The same race re-created catalog seams (`Seam task-intent-builder is already registered in
the catalog`, 2026-10). Every `createSeam({ catalog: coreSeamCatalog })` declares
    `owner: '<its own repo-relative path>'`. Under Vitest only, the catalog lets a second
    definition with the same owner and multiplicity replace the stale entry (with a warning) and
    still rejects any other duplicate. Outside Vitest every re-registration still throws
    `SEAM_DUPLICATE_PROVIDER`: there it means a real double load, and the owner is a plain string
    any module can copy. `libs/core/seam-reevaluation.test.ts` re-evaluates defining modules and
    fails on a catalog seam (in `libs/`, `presence/`, `satellites/` or `scripts/`) without its own
    path as owner.
  - **A per-pool store shared by consecutive files.** The test approval store
    (`active/shared/runtime/vitest-approvals/run-<id>/pool-<n>/`) outlives a test file.
    `operations-halt.enforcement.test.ts` left a `Merge PR 7` notice in
    `autonomy/actions.jsonl`, and `approval-decision-routing.test.ts` failed whenever it ran next
    in the same pool (2026-10). A writer clears its channels in `afterEach`; a reader asserts only
    on what it appended. The `tests/vitest-approval-store-guard.ts` setup file clears the pool
    store at its top level (evaluated per file before the file is imported, so records a file
    seeds at import time survive) and again after the file's own hooks (`sequence.hooks:
'stack'`), so the leftovers of one file never reach the next. It fails a file that left
    records behind under `KYBERION_TEST_LEAK_STRICT=1`, unless the file is on the shrink-only
    `tests/fixtures/approval-store-leftover-baseline.json` (34 files over the full root suite;
    a policy test caps the count and requires every entry to exist, and the guard notes a listed
    file that left nothing). `<id>` is a per-run nonce (`KYBERION_VITEST_RUN_ID`) that
    `vitest.config.mts` sets before the workers fork, so two Vitest runs in one checkout never
    wipe each other's pool; without a pool id the guard does nothing. Reproduce such a pair by
    running the writer and then the reader with `--maxWorkers=1` (both get pool 1). To see a
    reader's dependence, use a config without the guard in `setupFiles`.
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
3. Fix the cause (the classes above). Raise a timeout only for work that is legitimately heavy,
   such as a cold stack import in `beforeAll` or a real CLI end-to-end suite, and record the
   measurement next to it.
4. Force a timeout (`--testTimeout=<small>`) and check that only the timed-out test fails.

Writers and readers of the same file must resolve the path the same way. A reader through
`pathResolver.shared()` and a writer through `path.join(rootDir, …)` diverge under the sandbox:
the test passes against the sandbox while the writer leaks into live state.

**Real-process tests: size the budget from the child count.** A test that spawns
`node --import ./scripts/ts-loader.mjs` children pays a start-up per child. Before 2026-10-09 that
was about 5s of CPU (10s on a loaded 4-vCPU host), mostly re-transpiling every imported
`libs/core` source; with the start-up caches below a warm child that loads the `libs/core` sources
costs about 1.3s of CPU, but the first child after a source change or on a fresh checkout still
pays the cold cost. Size budgets from the cold cost.
`front-desk-recovery.engine.integration.test.ts` runs up to 17 sequential child batches. Its 180s
local budget failed on a busy host while CI (`CI=true`, 600s) stayed green.

- Bound each child with its own timer, using the same value locally and on CI.
- Size each test's timeout from its sequential child batches at the loaded per-batch cost
  (`engineTestBudget(batches)`). Use the same value locally and on CI, not a flat local constant.
- In `afterAll`, stop the children and wait for `'exit'`, not `'close'`, because a grandchild can
  hold the pipes. Bound the wait with a grace period, then send SIGKILL to any survivor. Remove the
  fixture roots in a `finally` block, and give the hook an explicit timeout.

**Child start-up cost: where it goes and what keeps it down** (MSN-OPS-ROUND5-20261009). Each
mechanism has an off switch and a test that compares its output with the switch off.

| Cost (cold child)                                                                                                                                                                                                           | Mechanism                                                                                                                                                                                                                                                                                                                                                          | Off switch                              | Test                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ts.transpileModule` for every TypeScript module, in every process                                                                                                                                                          | Transpile cache in `node_modules/.cache/kyberion-ts-loader/` (`scripts/ts-loader-cache.mjs`), outside every agent-writable tree: key = SHA-256 of the cache module's own text (it holds the options), TypeScript version, absolute path and source; 0700 dirs, 0600 entries, owner/mode checked on read; temp file + rename; TypeScript is required only on a miss | `KYBERION_TS_LOADER_CACHE=0`            | `scripts/ts-loader-cache.test.ts` (invalidation, poisoning, concurrency), `libs/core/tier-guard-ts-loader-cache.test.ts` |
| Node's default resolver runs `getPackageScopeConfig` for each `.ts` URL (type stripping is on by default in Node 24), and that call re-parses the whole `exports` string of the nearest package.json: 290KB for `libs/core` | `scripts/ts-loader.mjs` answers workspace TypeScript resolutions itself (`resolveTsSourceDirectly`, realpath URL)                                                                                                                                                                                                                                                  | `KYBERION_TS_LOADER_FAST_RESOLVE=0`     | `scripts/ts-loader-resolve.test.ts` (differential)                                                                       |
| The same re-parse for each `libs/core/dist/*.js` module                                                                                                                                                                     | The core build writes `libs/core/dist/package.json` (`type` + `#imports` only) and one-line shims re-exporting the real `.mjs` modules (`scripts/write_core_dist_scope.mjs --run`; `--check` drift runs in the packaging-contract gate). External consumers still resolve `@agent/core/*` through the full exports map                                             | `KYBERION_CORE_DIST_SCOPE=0` (build)    | `scripts/write_core_dist_scope.test.ts` (differential)                                                                   |
| `local-stt-discovery` probed every `python3.x` once per bridge installer                                                                                                                                                    | Memo + private host cache `node_modules/.cache/kyberion-stt-discovery/candidates.json`, both for 10 minutes, keyed on platform, PATH, registry content and the managed runtimes' bin lstat and site-packages mtimes; managed installers reset it; a hit rebuilds candidates from the registry and accepts only binaries the probe could have found                 | `KYBERION_STT_DISCOVERY_CACHE_TTL_MS=0` | `libs/core/local-stt-discovery.cache.test.ts`, `scripts/voice_setup.discovery-cache.test.ts`                             |

Rules:

- **A `#imports` entry needs a `./<file>.mjs` target in `libs/core/package.json`.** The dist scope
  shims only that shape, and the build fails with `CORE_DIST_SCOPE_UNSUPPORTED_IMPORT` for any
  other. A nested `dist/package.json` without `imports` breaks `#imports` in dist modules
  (`ERR_PACKAGE_IMPORT_NOT_DEFINED`); that was the failure of the first attempt.
- **A cache whose content decides what runs never lives in an agent-writable tree** (reviews
  H1/H2, MSN-OPS-ROUND5). Two such caches exist: the ts-loader transpile cache (entries run as
  code) and the local STT discovery result (its binary paths are what the speech-to-text bridge
  executes). In `active/shared/cache/` (security-policy `default_allow`) a data-only persona such
  as `finance_controller` could plant an entry through secure-io that the next run executed. Both
  use `libs/core/private-host-cache.mjs`:
  - location `node_modules/.cache/<name>/`, which secure-io denies to every persona and authority
    role (`tier-guard-ts-loader-cache.test.ts`; the operator-equivalent SUDO authority is the only
    exception); an override is honoured only outside the checkout or under its `node_modules/`,
    decided on the realpath of its deepest existing ancestor (a pnpm workspace link such as
    `node_modules/@actuator/x -> libs/actuators/x` cannot escape);
  - the cache root must be owned by the running uid with no group/other write bit; directories
    0700, files 0600; files are opened without following symlinks, `fstat`ed, and deleted unless
    they have the reader's uid and no group/other write bit;
  - off on Windows unless `KYBERION_WINDOWS_PRIVATE_CACHE=1`: there is no uid or POSIX mode to
    check, so the checks would fail open;
  - no MAC: a process that can write the cache as this uid can also read any per-user key and
    edit the checkout's code directly.

  Defence in depth for the STT cache: it stores only (backend, source, binary, version); a hit
  rebuilds each candidate from the governed registry and accepts a binary only where the probe
  could have found it (the tool's own managed python, or a PATH directory outside `active/`,
  `knowledge/`, `customer/`, `vault/`). **Trust-model exception:** these are the only runtime
  stores outside `active/`, outside secure-io and outside the retention catalog; the transpile
  cache prunes entries written more than 30 days ago (at most daily), the STT cache is one file.
  **Symlink write-through is closed in secure-io (V4, #1019).** Before it, secure-io checked a
  path as written while the OS followed symlinks, so a persona could link `active/shared/tmp/x`
  to `node_modules/.cache/<cache>` and write through the link (same uid, 0644, so the owner/mode
  checks did not catch it). secure-io now refuses to create such a link and refuses writes
  through one; re-verified for both caches as `finance_controller` and `worker`.

- **The cache key covers the loader itself.** It hashes `scripts/ts-loader-cache.mjs`, where the
  compiler options live, so editing the options invalidates every entry with no version to bump.
- **Cached code never carries a code extension.** Transpile-cache entries end in `.transpiled`.
  Repository scanners (the foundation-io, process-boundary and runtime-child-process boundary
  tests, lint and governance gates) select files by extension and not all of them skip `active/`;
  `.js` entries made every cached `libs/core` module a second, unregistered importer.
- **Never cache data.** The transpile cache skips `active/`, `knowledge/`, `customer/` and `vault/`
  sources (compared case-insensitively on darwin and win32).
- **Keep caches fresh across installs.** Managed-tool installers (`voice setup --apply`,
  `tool-runtime setup --apply`, `env:bootstrap --apply`) call
  `resetLocalSttDiscoveryCache({ disk: true })` when they finish. A new installer that can add a
  local STT backend does the same.
- **Run build helpers by `import.meta.main`, not by comparing `process.argv[1]`** with the
  module's own path: under a symlinked checkout they differ and the dist-scope write was silently
  skipped (review M2). The build passes `--run` explicitly. `import.meta.main` needs Node 24.2
  while `engines` admits 24.0, so a direct run without it exits 1 with a diagnostic (review L2).
- **Tests point caches at a sandbox.** Unit tests pass `KYBERION_TS_LOADER_CACHE_DIR` (a private
  os tmp directory) and `projectRoot`. Child processes that tests spawn share the checkout's
  transpile cache in `node_modules/.cache/`, outside the leak guard's live-state roots. The STT
  disk cache is off under Vitest unless the TTL is set; its tests set
  `KYBERION_STT_DISCOVERY_CACHE_DIR` to a private os tmp directory.
- **Fast resolve stands aside when Node preserves symlinks** (`--preserve-symlinks[-main]` in argv
  or `NODE_OPTIONS`, or `NODE_PRESERVE_SYMLINKS=1`): it returns realpaths.

Procedure when a child is slow: profile it (`node --cpu-prof --import ./scripts/ts-loader.mjs …`)
and sum self time per function. Large `get` (`package_json_reader`) plus garbage-collector time
means a large package.json is being re-parsed: look for a new resolution path that bypasses the
mechanisms above. Measure each change separately in alternating runs and compare CPU (user + sys),
as in §1. Reference numbers (4 vCPU, load average 8–10, median CPU of 5–7 alternating runs, before → after):
`scripts/bindings.ts --help` (libs/core from sources) 13.8s → 1.3s; `scripts/org.ts --help` (dist)
2.4s → 0.4s.

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
- **Document duplicate evidence belongs to the selected tenant.** The explicit ingest ceremony
  reads committed asset hashes from that tenant's information-asset ledger. Never use the
  standalone actuator's shared hash registry to decide whether a tenant import may land, and
  never add a second hash-registration write after the card/ledger commit. A legacy global
  registry is neither migration authority nor proof that the selected destination has the file;
  leave it untouched. Preserve historical-hash and source-version/reparse semantics. Verify with
  `scripts/ingest.dedup-ordering.test.ts`: identical bytes into two tenants, independent updates,
  read-only previews, foreign legacy rows, a failed ledger append, and a retry after a committed
  ledger entry with no registry record. This does not claim concurrent commit atomicity.
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
    possession (the mission brief page) resolves the decider server-side, and with the setting on
    refuses every approval (rejections still pass): any local process can open the page, so the
    operator approves on Chronos, presence-studio or the terminal TTY challenge instead.
  - The terminal has one operator principal (`libs/core/governance/cli-operator-principal.ts`):
    the local owner member, recorded as `user:<member_id>` both as `requestedBy` when a CLI or
    script opens a request and as `decidedBy` for `pnpm kyberion approvals --approve`; the
    onboarding name goes to `requestedByDisplayName` / `decidedByDisplayName` and is never
    compared. A CLI run inside an agent session (`KYBERION_AGENT_ID`, `KYBERION_NHI_ID`,
    `KYBERION_RUN_ORIGIN=agent`, or a provider harness marker such as `CLAUDECODE`, declared per CLI as `cli.session_markers` in `reasoning-providers/`) opens requests
    as `agent:<…>`, so a human approving it is not a self-approval. The detected principal is always
    kept as `requestedByContext.actorId`; `--requested-by` only adds an identity. With the setting
    on, a terminal with no owner member (`pnpm organization member ensure-owner` provisions it) or an
    approval typed inside an agent session is refused with a diagnostic, never recorded under a
    placeholder, and a terminal approval needs an interactive TTY and a typed one-time code
    (`decidedVia: 'cli_tty_challenge'`; no flag skips it; no TTY points at Chronos or
    presence-studio). With it off, a decision typed in an agent session is recorded as
    `caller_supplied` with `decidedInAgentSession`, so it fails a later re-check.
  - **This is best effort, not a security boundary.** Agent-session markers are environment
    variables an agent can clear, and anything that gives an agent a pseudo-terminal can read and
    type the challenge code: terminal-actuator, but equally `script`, `expect`, `unbuffer` or a shell
    coproc. The challenge times out after 120s (`[POLICY_VIOLATION] challenge timed out`) and
    records nothing. The strong path for a separated approval is an authenticated
    surface (Chronos or presence-studio).
  - Every consumer that turns an approved record into an effect checks it first under a consumer
    id (`assertApprovalUsable` / `approvalUsabilityRefusal`); the registry is
    `libs/core/governance/approval-sod-consumers.contract.test.ts`. A decision recorded while
    the setting was off cannot take effect after it is on, and re-request helpers never hand back
    such a record.
  - A missing `approval-policy.json` (no customer overlay and no product file) means the shipped
    default (off), logged once at debug. A file that is present but unreadable or schema-invalid
    blocks approving decisions and approval use even with the setting off (fail closed,
    diagnostic message); plugin activation degrades to `pending_approval` with a warning, and a
    pending DOT autonomy promotion stays pending until the next sweep.
  - `pnpm kyberion approvals --revoke <id> [--reason …]` revokes an approved record: further uses
    are refused (an effect that already happened is not undone). Allowed for its requester, one of
    its approvers, or the local owner — resolved server-side by `revokeApprovalAsLocalOwner`, never
    asserted by the caller. Audited as `approval_decision` / `revoke` and a `revoked` event. Whatever
    the setting, `evaluateApprovalUsability` refuses a revoked record for every consumer, and
    separation-of-duties refusals name the revoke command. One-shot consumers that take no apply
    claim record consumption with `markApprovalConsumed` (`service_recording_promotion`,
    `organization_decision`), so the approval is used once and a later revoke reports it consumed.
  - `service_recording review` decides through the store (`service-recording-review` channel,
    requested at `capture` or `request-review`); promotion re-checks the approval
    (`service_recording_promotion`).
  - Known limits (string identities, a human typing into an agent session's shell, policy/service
    deciders) are listed in [approval-gate-design](./approval-gate-design.md).
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
   `libs/core/governance/approval-separation-of-duties.test.ts`). A creator that runs in a CLI or
   script resolves its requester at the CLI entry point (`scripts/lib/cli-approval-requester.ts`,
   `resolveCliApprovalRequester({ explicit, legacy })`) and passes it to the library as a lazily
   resolved `ApprovalRequesterInput` — never from the persona, a component name or
   `resolveOperatorDisplayName()`, and never read from the environment inside `libs/`. Record
   `approvalRequesterActorId(requester)` as `requestedByContext.actorId`, never a copy of
   `requestedBy`. A terminal decision goes through `decideApprovalFromCli` (gates:
   `scripts/approvals_cli_identity.test.ts`, `approval-sod-consumers.contract.test.ts`).
6. When you add code that turns an approved record into an effect, call
   `assertApprovalUsable(record, { consumer })` before the effect. When you add a decision surface
   that takes the decider from its caller instead of a resolved session, pass
   `deciderIdentitySource: 'caller_supplied'`; when it falls back to a placeholder decider id,
   add that id to `APPROVAL_PLACEHOLDER_DECIDERS` (gates: approval-separation-of-duties.test.ts,
   `approval-actuator-sod.test.ts`). A consumer that only runs the check while separation of
   duties is on must still run it on a record it can load, so a revoked approval is refused
   (gate: `approval-revocation.test.ts`, contract test).
7. A consumer must not skip its usability check while separation of duties is off: a revoked
   approval is refused whatever the setting. The contract test fails on any
   `!isSeparationOfDutiesEnabled()` guard in a consumer file outside its listed, justified
   exceptions. A one-shot consumer without an apply claim calls `markApprovalConsumed`.
8. Never add an approve/reject flow that writes its decision outside the approval store (as
   `service_recording review` did): open a hash-bound request in its own channel, decide it with
   `decideApprovalRequest`, and register the consumer that turns it into an effect.

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
tracks before changing ownership projections, and records the prior status so the
explicit restore operation can return to it. All project and track writes —
create and bootstrap included — require the mission owner.

**Procedure.** When changing project or track statuses, update the CLI and typed
facade together, reconcile operational state and default track membership, and
preserve rollback and audit behavior. Verify descriptive edits do not implicitly
restore archived records or reselect the default track.

**Gate.** Run the focused lifecycle regressions in
`libs/core/project/project-management.test.ts` and build core plus the repo CLI.
These cover archive entry-point parity, restore, and track state/projection changes.

---

## §10 secure-io symlink and hard-link canonicalization

**Defect class.** The tier guard (`validateWritePermission` / `validateReadPermission`) judges a
path as written, but the OS follows symbolic links in every component, and a hard link is a second
name for an inode that lives elsewhere. Before this fix a data-only persona
(`KYBERION_PERSONA=worker MISSION_ROLE=finance_controller`) could call
`safeSymlinkSync('scripts', 'active/shared/tmp/link')` (the target needed only _read_ permission)
and then `safeWriteFile('active/shared/tmp/link/x.ts', …)` — landing code in `scripts/`. The same
link turned every write helper (append, copy, move, mkdir, rm) into a write anywhere readable; a
link in a readable location exposed `knowledge/personal/` to readers below that tier; and a hard
link planted with raw fs let append / copy / chmod / fsync / read act on a protected inode.

**Rules:**

- **Every guarded path is checked twice: literal and canonical.** secure-io routes every write-type
  helper through `guardWritePath` and every read through `guardReadPath` /
  `assertCanonicalReadable` (`libs/core/secure-io-path-guard.ts`; only `secure-io.ts` may import
  it, enforced by `security-boundary.contract.test.ts`). Both the literal path and the canonical
  path (realpath of the deepest existing ancestor plus the missing tail, a dangling link followed by
  hand) must pass. Never add a write or read helper that calls `validate*Permission` on the literal
  path only.
- **Pick the mode by what the syscall follows.** `follow` for operations that follow a final link
  (open, append, copy, chmod, mkdir, read, stat, statfs). `leaf` for operations on the entry itself
  (rename source and destination, unlink, rm, rmdir, lstat, readlink, link creation, hard-link
  source): only the parent is canonicalized, so removing or moving a link stays possible.
- **No realpath cache.** Every check walks the path afresh. A per-process cache was tried and
  removed: an ANCESTOR renamed into a protected tree with a link left at its old path (through raw
  fs, or by another process) re-verified as "same inode", and cache clearing on secure-io mutations
  is per-process only, so it never sees such a rename.
- **The canonical path lives in the logical root space.** A canonical path under
  `realpath(rootDir())` is re-expressed under `rootDir()`, so a checkout reached through a linked
  prefix (macOS `/var`, a fixture root) keeps matching policy prefixes. The Vitest live-subtree
  remap is applied once, by `pathResolver.resolve`, to the literal path; the canonical path is the
  physical location and is never remapped again.
- **Case-insensitive volumes judge the on-disk spelling.** Whether the root's volume folds case is
  probed once per root (on the nearest root component whose name has letters). In `leaf` mode the
  leaf takes its on-disk spelling (`knowledge/PERSONAL` is judged as `knowledge/personal`) from
  `lstat` + realpath (trusted only if realpath reached the `lstat`'d entry); the directory is
  listed only when the leaf is itself a symlink or was swapped in between. In `follow`
  mode the platform realpath already returns the on-disk case. Tier detection stays case-sensitive.
- **Foreign hard links are refused for in-place access.** Read, size (`validateFileSize`),
  metadata (`safeStat`, `safeFileAgeMs`), copy source, append, open-for-append, chmod, fsync, move
  source and hard-link source refuse a regular file with `nlink > 1`, checked on the opened
  descriptor where the helper opens one (copies read from that descriptor; snapshots return bytes
  only from the vetted inode, and a file missing at check time must be single-link when opened).
  Every exemption below is judged on the canonical path re-derived after the open, so it applies
  only when that canonical path still names the inode the caller holds (`(dev, ino)` of
  `stat(canonical)` equals the descriptor's). Without that pin, a symlink flipped between the open
  and the check let a planted hard link be read as if it were a pnpm-store or out-of-repository
  file. A multi-link file outside the repository (a vault mount target) gets no exemption. There are two exceptions, both
  narrow on purpose (a broader "all links in one directory" rule was defeated by moving the link
  next to its protected sibling):
  - _Lock recovery tombs, probe-only_: in `active/shared/runtime/locks/`, a file named
    `<base>.stale-<pid>-<ms>-<n>` with exactly two links whose other link is `<base>` (one `lstat`;
    no directory listing, so filling the directory cannot block it). The `<base>` side is refused —
    finding its tomb would need a listing. `lock-utils` therefore reads a record through its
    `.stale-*` tomb when the base side is refused as a hard link, so `releaseLock` and lock
    inspection see the live owner during the put-back window. A tomb may move only within its
    locks directory, never to another name such as `MEMORY.md`.
  - _pnpm store reads_: decided on the **canonical** path. The content store
    (`node_modules/.pnpm/`, written only by the package manager) is exempt for every caller,
    SUDO included. Elsewhere under the root `node_modules/` or a workspace package's
    `node_modules/`, the canonical location must not be writable by the caller. The literal
    prefix is never trusted: root `node_modules/` holds pnpm's workspace links
    (`node_modules/@actuator/service -> libs/actuators/service-actuator`) into trees a role may
    write.
- **In-place opens never truncate.** `safeAppendFileSync` accepts only `a`, `a+`, `ax`, `ax+`;
  `openInPlace` rejects any other flag before opening, so a foreign hard link is never truncated
  before it is vetted. Writes that replace the entry — `safeWriteFile` and the copy destination
  (temp + rename) — never touch the old inode.
- **A symlink is a standing write grant.** `safeSymlinkSync` requires write permission on the
  canonical target, refuses targets that resolve outside the repository, stores the link relative,
  and accepts only `dir` / `file`. `junction` is refused there and in the orchestrator `symlink`
  pipeline op: a junction needs no privilege on Windows and always stores an absolute target.
  `safeLinkExclusiveSync` also needs write permission on its source.
- **Out-of-repository reads stay vault-only.** A read whose canonical path leaves the repository
  passes only through a registered vault mount (`isAllowedVaultMountPath`, which also accepts the
  mount target's realpath). Vault mounts are read-only; writes through them are refused.
- **Check late; re-verify after open.** `safeWriteFile` runs the literal check first, the policy
  engine next (with the tier of the canonical path), and the canonical permission check last,
  just before creating directories. It writes its temp file in the checked (canonical) directory
  and, once the temp descriptor is open, requires that directory to still be the same `(dev, ino)`,
  still canonicalize to itself, and to hold the descriptor just opened before renaming into place.
  An inode number of 0 (FAT/exFAT, some network shares) is unverifiable and fails closed.
- **Not-found errors carry `code: 'ENOENT'`.** `safeReadFile`, `safeReadFileRange` and
  `safeReadFileTail` throw `File not found` with `code: 'ENOENT'`, so callers that classify
  errors by code (lock inspection: missing vs unreadable) see a missing file as missing.
- **Missing parents are created one at a time.** `safeWriteFile`, `safeMkdir` (recursive),
  `safeOpenAppendFile`, `safeCreateExclusiveFileSync`, `safePublishExclusiveFileSync` and
  `safeSymlinkSync` create missing directories through `mkdirGuarded`, which takes the canonical
  directory the permission check judged as its baseline: before each component the parent must
  still canonicalize to that checked location, so a component swapped for a link cannot leave
  directories in another scope.

**Residual risk (documented, not closed).**

- _Check-to-use race._ Other helpers still run their syscall on the literal path after the check;
  a concurrent process that swaps a component for a link between the two can redirect one
  operation. `safeWriteFile` narrows the window to the rename after its re-verification.
- _Hard links created after the check_ (between the descriptor's `fstat` and the operation) and
  hard links to files outside the repository (vault targets) are not detected. Path-only helpers
  (`safeStat`, `safeLstat`, `safeExistsSync`, `safeReaddir`) reveal metadata of a hard-linked
  file but no content.
- _Per-process state_: nothing is cached, because cache clearing is per-process only and never
  sees a rename done through raw fs or by another process.
- A raw-fs or out-of-process actor can always bypass secure-io; these rules govern what a persona
  can do through secure-io.

**Procedure.** When you add a filesystem helper to secure-io, call `guardWritePath(path, mode)` or
`guardReadPath(...)` instead of the bare tier-guard functions, pick the mode from the rule above,
and use `openInPlace` for any operation that reads or modifies an existing inode in place. When a
test needs a link, create it inside `active/shared/tmp/` with a target the test persona may write
(`safeSymlinkSync`), or plant it with raw `node:fs` when the test models a link created outside
secure-io. A link target in `os.tmpdir()` is outside the repository and is refused. A fixture root
needs copies, not links, of catalogs from the real checkout.

**Cost.** realpath(3) walks every component: about 30 µs per call at depth 15. Measured on an idle
CI VM (median µs/op, 2,000 ops × 5 runs, deep path in `active/shared/tmp/`, two runs each),
main → this fix: append 378–393 → 437, read 107 → 86–93 (fd-based read does fewer syscalls),
stat 52–54 → 72–78, mkdir (existing) 376–378 → 429, safeWriteFile (atomic + fsync) 1114–1129 →
1277–1283.

**Gate.** `libs/core/secure-io.symlink-canonical.test.ts` (symlink-then-write, append, mkdir,
dangling link, copy/move through a linked parent, rm/unlink, reads into `knowledge/personal/`,
junction refusal, ancestor rename after an earlier resolution, hard-link append / copy / chmod /
fsync / read / move / stat / snapshot, probe-only lock tomb rule and tomb moves, truncating append
flags, `node_modules` planted in a writable tree, `node_modules/@actuator/service` workspace alias
read as `software_developer`, exemption pinned to the held inode (unit + bounded symlink-flip race),
SUDO pnpm-store reads, ENOENT code, `validateFileSize` tier and hard-link guard, directory
swap between check and temp open, single probe registration, `node_modules` read exemption,
legitimate links in scope, Vitest remap, vault reads), `libs/core/secure-io.symlink-root-alias.test.ts`
(checkout behind a linked prefix), `libs/core/foundation/lock-utils.tomb-release.test.ts` (release
during the put-back window, against the real secure-io lock IO) and the import boundary in
`libs/core/security-boundary.contract.test.ts`. Each attack case fails on the pre-fix code.

---

## §11 Actuator failure receipts and terminal capabilities

**Rule.** A failed or denied actuator result must remain a failure in both the
resident CLI envelope and the one-shot process exit code. Preserve the result
payload for diagnosis. A pipe terminal cannot resize and must report that limit.

**Procedure.** Verify the result status and observed outcome after acting. Reject
ambiguous browser targets and empty target sets before recording success. Require
explicit string fill values, including after template resolution; an explicit
empty string may clear a field. Re-observe after a rejected reference or timeout.
For terminal operations, retain the session ID and command exit code, and return
missing-session or unsupported-capability diagnostics instead of false success.

**Gate.** Run `scripts/actuator_playground.test.ts`, `libs/core/cli-utils.test.ts`,
the browser and terminal actuator tests, and `libs/core/shell/pty-engine.resize.test.ts`.
Replay `scripts/browser_actuator_usability_probe.ts` and
`scripts/terminal_actuator_usability_probe.ts` for live outcomes and recovery.
Native PTY and desktop GUI checks require the corresponding host capabilities.
When adding probe scratch with `sharedTmp()`, register the exact call count and
the consumable diagnostic purpose in `shared-tmp-allowlist.json`, then run
`tests/shared-tmp-ratchet.test.ts`. Preserve durable conclusions in mission
evidence instead of relying on scratch files after their retention window.

---

## Maintenance

When a defect class not listed here recurs:

1. Add a section with the rule, the procedure, and the gate or test that enforces it.
2. Link the section from [kyberion-development-practices](./kyberion-development-practices.md) and
   the pre-PR checklist.
3. Record the incident in the mission's retrospective.

A rule without an enforcing check is a candidate for the next gate.
