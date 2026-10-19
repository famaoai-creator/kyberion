---
title: 'Operations Hygiene Runbook: keeping fixed operational gaps fixed'
tags:
  [governance, operations, ci, retention, daemons, tests, recurrence-prevention, secure-io, symlink]
last_updated: 2026-10-19
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

| Class                         | Gate / check                                                                    | Section |
| ----------------------------- | ------------------------------------------------------------------------------- | ------- |
| CI workflow drift             | `ci-workflow-contract` (scope `pr`)                                             | §1      |
| Red CI without a next step    | `Triage failure` job-summary step, `main-failure-triage.yml` (`ci-main-red`)    | §1      |
| Undeclared runtime stores     | `runtime-store-retention` (scope `pr`), janitor `uncovered*` lists              | §2      |
| Daemons and child processes   | unit tests per daemon; this checklist in review                                 | §3      |
| stdout / logging in libraries | eslint `no-console` on `libs/`                                                  | §4      |
| Test pollution and host deps  | Vitest leak guard, strict in CI (`KYBERION_TEST_LEAK_STRICT=1`)                 | §5      |
| Tenant scope and facade env   | `tier-guard-tenant` tests, facade binding tests                                 | §6      |
| LLM / provider calls          | per-call-site egress tests (e.g. `mission-distill-egress.test.ts`)              | §7      |
| Mission evidence overwrites   | generator and phase-pipeline tests in `mission-retrospective.test.ts`           | §8      |
| Project lifecycle facades     | lifecycle regressions in `project-management.test.ts`                           | §9      |
| secure-io link escapes        | `secure-io.symlink-canonical.test.ts`, `secure-io.symlink-root-alias`           | §10     |
| Actuator failure receipts     | cli-utils / actuator tests, `pty-engine.resize.test.ts`, probes                 | §11     |
| CLI hook continuation loops   | `scripts/codex_cli_hook.test.ts`, `libs/core/provider/claude-code-hook.test.ts` | §14     |

---

## §1 CI workflows

**Compiler readiness and recovery accounting.** `pnpm build`, `pnpm build:packages` and
`pnpm build:repo` enter the source-only `scripts/build_repository.ts` bootstrap. The compiler
writer and L2 baseline scanner share the `compiler-outputs` mutex; standalone clean uses the
same mutex. Never call a wrapped build recursively while holding it. Direct package-local
compiler invocations and ad-hoc cleanup bypass this coordination: use the root entrypoints
when other processes are observing this checkout. The bootstrap and its cleanup imports stay
out of the runtime emit graph (`ROOT_SOURCE_EXCLUSIONS`, `tsconfig.json`); bootstrap tests live
under `tests/` so importing them cannot pull source-only modules back into that graph.
Register source-only entrypoints explicitly in both the ESM integrity gate and
`tests/package-boundary-contract.test.ts`; register white-box bootstrap test imports by exact
specifier. Run that boundary suite whenever bootstrap imports change.
On Windows, spawn package-manager lifecycle stages through Node and the pnpm-provided
`npm_execpath` JavaScript entrypoint; `.cmd` shims cannot be executed with `shell: false`.

Health observations never consume L2 recovery attempts. Only executed compiler commands record
repair outcomes; lock contention is not an attempt. A successful partial command clears the
budget only if all compiler outputs pass import/freshness checks. UI failures do not consume
the compiler budget. Busy observations defer with `needs_attention`; persist bounded, redacted
diagnostics and retain full structured source/output provenance in the baseline report.
State mutations reload and merge under the PFC state lock; slow probes cannot undo a newer
recovery result. Gates: PFC, compiler-coordination, build-runner and baseline-readiness tests.
Normal SIGINT/SIGTERM cancellation forwards to the managed compiler process group and keeps
the mutex until the child closes, with bounded escalation. This is cooperative serialization,
not a crash-safe lease: after force-killing the wrapper (SIGKILL), stop any surviving compiler
children before starting another build. PID-based stale-lock recovery cannot identify those
orphans on its own.

**GitHub CLI diagnosis.** Run the existing `gh_status` operation before resetting authentication.
For ordered diagnostic markers in uncontrolled CLI output, use a fixed number of literal
searches per line rather than unanchored `marker.*marker` regexes. Cover repeated-marker
inputs and line boundaries in `github-diagnostics.test.ts` to prevent polynomial scanning.
DNS and network failures take precedence over generic auth wording. `gh auth status` saying
that a token is invalid does not establish API rejection: only explicit HTTP 401 / Bad credentials
does. Credential-store access failures need a comparison with the operator's normal host
terminal. Shell and connected-app authentication are independent; a CLI probe leaves connector
status `not_probed`. Never persist token values, change host DNS/hosts, or copy credentials as a
diagnostic workaround. Gates: `github-diagnostics.test.ts` and `gh-status.test.ts`.

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
   `pull_request` and `merge_group` events at step level, so check names stay stable for branch
   protection. See `.github/workflows/README.md`.
2. **No skip cascade.** A test or smoke job never `needs` a lint/validate job — only the shared
   `build-artifacts` job — and independent check steps inside one job run with
   `if: ${{ !cancelled() && steps.workspace.outcome == 'success' }}`, so one push reports every
   failing signal. Path-based skipping lives in a `changes` job plus an always-running result
   job (`cross-os-result`), never in a workflow-level `paths:` filter (required checks would stay
   pending). Every workflow with required checks also triggers on `merge_group`.
3. **Do not depend on step order between workflows.** Example: a test that `mkdtemp`s under
   `active/shared/tmp/` must create that directory itself. Once cross-os stopped running the core
   shards first, such a test failed on CI.
4. **Grep `tests/` for pinned workflow text** (`grep -rn "actions/" tests`).
   `tests/workflow-operations-contract.test.ts` asserts parts of the workflows.
5. Run `pnpm check -- --only ci-workflow-contract` and the prettier format check over the workflow
   files.
6. **Keep a new test or check step triageable.** Pipe its output into the job's capture log
   (`shell: bash` and `2>&1 | tee -a "$RUNNER_TEMP/kyberion-ci-output.log"`; `shell: bash` turns
   on `pipefail`, so the step still fails). End the job with the `Triage failure` step
   (`if: failure()`, `uses: ./.github/actions/ci-failure-triage`).

### CI failure triage — who acts on what

A red job writes a **CI failure triage** section to its job summary. The section lists each failure
with a root-cause class, a stable signature and the exact next command. The same classifier runs
locally: `pnpm kyberion ci triage <log-file ...> [--job <name>] [--json]`, or pipe a log into it
(`gh run view <id> --log-failed | pnpm kyberion ci triage`). Read the triage before you open the
raw log, and act on it in one round:

| Class                  | Meaning                                                                                                                    | Who acts / next step                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generated-drift`      | A freshness gate (`op-registry`, `env-registry`, `vocabulary-types`, …) found a stale generated file (`"changed": [...]`). | PR author. Run the printed generator (derived from `ci-gates.json`, e.g. `pnpm generate:op-registry`), or `pnpm kyberion resolve generated`, then commit the result. Re-run the gate with `pnpm check -- --only <gate>`.                        |
| `ratchet/registration` | A ratchet grew (`increased from X to Y`) or a boundary / allowlist / registration test failed.                             | PR author. Follow the registration ceremony in [kyberion-development-practices §1](./kyberion-development-practices.md). Prefer fixing the code over growing a baseline.                                                                        |
| `gate-failure`         | Another `pnpm check` gate or the type checker failed.                                                                      | PR author. Run the printed `pnpm check -- --only <gate>` or `pnpm typecheck`.                                                                                                                                                                   |
| `test-failure`         | A Vitest test failed. The triage prints the assertion and a targeted rerun command.                                        | PR author. If the test is marked `suspected flake` (timers, TTLs, timeouts), reproduce it with the loop command. Fix it with fake timers or an explicit clock. Never just retry. See [WRITING_TESTS](../../../docs/developer/WRITING_TESTS.md). |
| `platform`             | The test failed only in a macOS / Windows job.                                                                             | PR author. Apply §2 of [kyberion-development-practices](./kyberion-development-practices.md) (cross-platform determinism). A test that fails only on slow hosted runners is also a flake candidate.                                             |
| `infra`                | Install, checkout, network, artifact or runner trouble before the tests ran.                                               | Anyone. Re-run the failed jobs (`gh run rerun <id> --failed`). If it repeats, treat it as a workflow defect and fix it under this section.                                                                                                      |
| `unknown`              | Nothing matched. The triage attaches the first error block.                                                                | PR author. Read the failed step log. If the shape will recur, add a pattern and a fixture to `scripts/lib/ci-failure-triage.ts` / `scripts/ci_failure_triage.test.ts`.                                                                          |

**Red CI on your own PR.** Read the job-summary triage (or run `pnpm kyberion ci triage` on the
log), fix every listed failure in one push, and re-run the printed commands locally first. Pending
CI is not green.

**Red CI on `main`.** `.github/workflows/main-failure-triage.yml` runs after a failed `CI` or
`Cross-OS Smoke` run on `main`. It opens one issue per failing signature (label `ci-main-red`,
deduplicated by the hidden `ci-triage-signature` marker), or comments on the open issue that already
has that signature. The agent that picks up the issue fixes it on a branch from `main` and opens a
fix PR whose body says `Fixes #<issue>`, so the merge closes the issue.

**Port main fixes to affected PRs.** A PR branched before the fix keeps failing with the same
signature. After the fix PR merges, update each open PR whose triage shows that signature: rebase
or merge `main`, or port the fix commit. Do not re-diagnose the failure on each PR.

**Generated catalogs in shared checkouts.** Regenerate knowledge indexes in the PR's isolated
worktree, using only the files that ship with that branch. A shared checkout can contain another
task's untracked knowledge file; its index entry then becomes a broken link in CI. Before pushing,
run `pnpm generate:knowledge-index` and the `documentation-links` PR gate in the isolated worktree.
Do not copy an index from a dirty checkout or add another task's document to satisfy the link.

**Build-artifact identity and diagnostics.** Freshness checks must compare directory
components after artifact-only path normalization: a buildinfo entry under `src-other/`
or named `src.ts` is never evidence that the compiler owns `src/`. Keep Windows
case/slash identity normalization local to build artifacts; never reuse it for tenant
or security paths. Source-specific failures name the actual scanned source and its
expected emit, each with that file's own timestamp; absent emits have a null timestamp
and orphan emits have no source provenance. Only mtime fallback uses target-wide newest
files. Cover older changed inputs beside newer unchanged inputs and missing/orphan
outputs in `scripts/check_stale_dist.test.ts`. Platform-specific fixtures must be
explicit skips elsewhere and included in the native platform's CI command;
`tests/workflow-operations-contract.test.ts` pins the Windows invocation.

**Gate budgets (`pnpm check`).** `scripts/run_checks.ts` defaults to at most 6 concurrent gates
with a 120s default per gate (`DEFAULT_GATE_TIMEOUT_MS`). On a resource-constrained host,
use `pnpm check -- --scope pr --jobs 1` (integer range 1–6). This changes scheduling only:
all selected gates, per-gate budgets, manifest-order reports and failure exit codes stay the same.
Pass `--check-jobs 1` to `pnpm kyberion pr create` so its real readiness rerun uses the same bound.
A failed or resource-terminated gate remains a failure; never substitute an isolated pass or
`--skip-readiness` for the complete run. Compare default and serial scheduling with
`scripts/run_checks.concurrency.test.ts`, and verify the complete selected set on the host.

A gate that times out on busy runs:

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

### Hearing writer consistency

- Every hearing writer uses `updateHearingRecord` with the same namespace/session inter-process lock. Never lock only the final save of an older snapshot. Async preparation runs outside the lock; reload and compare the relevant revision before writing.
- `record_revision` fences replacements; `requirements_revision` tracks semantic requirements, excluding canvas and source-turn metadata. Changed answers invalidate the human decision. Missing legacy revisions mean zero; malformed revisions fail closed. Canvas version allocation and HTML publication share the record lock, skip orphan versions, and never overwrite an existing version.
- Complete or partial handoff markers prevent requirement edits. Before an external effect, validate the decision again and persist a short-lock reservation; never start if that write fails. After effects start, failures retain the reservation. Never clear it based on elapsed time or claim that a failed response proves no effect occurred. Inspect existing mission/inventory outcomes instead of starting the same work again.
- Durable hearing storage and explicit copy-on-write migration now follow the receipt procedure below. Legacy tmp-only records retain the old 24-hour risk until migrated; a reservation is never proof of an external effect.
- All writer processes must use this protocol and share filesystem/PID namespaces. Stop old writer processes before starting upgraded writers; a mixed-version rolling deployment is not supported. A code rollback does not migrate data, but old code ignores the protections: quiesce writers and inspect outstanding reservations before rollback. Do not erase fields to make a retry possible.
- Regression gates: `hearing-write-consistency.test.ts` exercises deferred races, legacy inputs, scope isolation and write-failure injection; `hearing-process-consistency.test.ts` runs two real child writers. The hearing client suites verify bounded conflict messages without clearing pending/unknown guards.

### Durable hearing decision receipts

- Hearing records and canvases now use `active/shared/runtime/hearing/<tier>/<tenant|shared>/<namespace>/<session>/`. Tenant hearings are confidential; legacy local `all`/`unscoped` namespaces are personal/shared. Reject named tenants that collide with those legacy sentinels and ambiguous multiple-tenant scopes. Do not infer a tenant or downgrade invalid names to shared.
- The hearing-only state registry enforces secureIO knowledge-tier read/write permissions, tenant isolation, and fail-closed missing/corrupt or incomplete hearing protection declarations. A server-viewer-derived storage facade uses the existing authorized role only during synchronous hearing storage/lock operations. Its closed data-only operations clone inputs before elevation and never accept caller callbacks. It captures scope before background work, rejects token writes and token access to personal/shared, and never elevates model calls or downstream execution.
- Aggregate directory moves and recursive removal at the hearing root or its ancestors require protected-tier and tenant authorization, including canonical path aliases. Broad runtime write permission must never relocate private receipts into an unprotected tree. Keep structural mkdir separate from destructive aggregate operations.
- New explicit mutations atomically publish a staged session directory under the existing lock. Legacy reads remain read-only. On explicit POST, copy available legacy canvases and the updated record into the stage, then rename it into place. Failure before publication leaves legacy authoritative; after canonical publication, missing/corrupt records or missing canvases never fall back to tmp. Background canvas completion cannot migrate a legacy-only session.
- Persist versioned decision requests with `version: 1`, `operation_id`, `scenario_id`, and `requirements_revision`. Their receipt is embedded in the same atomic record write and binds namespace/session, authenticated principal/member/source, server-derived organization/project/tier scope, scenario and revision. Exact same-ID replay is read-only; different bindings return 409. New stale requests return 409. Legacy empty-body decisions keep their snapshot fence but create no receipt and cannot backfill old browser markers.
- `GET /api/hearing/:session/decision-receipts/:operation` requires the exact version/scenario/revision and authenticated decision-capable member. Missing evidence returns `unknown`, never proof of non-execution. Superseded receipts prove only historical acceptance: replay does not restore decided fields or return current record/handoff guidance. Ordinary hearing responses omit internal receipts and operation pointers. Receipt collections are bounded at 128; reaching capacity fails closed without deleting prior proof.
- The new root is `review_required`, with no TTL and no automatic metrics/tenant-offboarding enrollment. Operator deletion/export requires a separate reviewed recovery/retention decision. Never erase receipt evidence or unresolved downstream reservations to enable retry. Existing tmp-only hearings are still vulnerable to tmp expiry until explicitly migrated.
- Rollout requires all hearing writers to be quiesced and upgraded together. Old versions continue using tmp and must not run beside, or be rolled back over, migrated durable sessions. Do not delete canonical directories to make old data reappear: complete operator deletion destroys the migration authority marker too, so recovery from that destructive action is not guaranteed. Inspect/reconcile outstanding records before any operator-led rollback. The lock requires shared filesystem and PID namespaces; atomic writes support process restart recovery, not multi-host exactly-once or power-loss-proof persistence.
- Backend receipt support does not upgrade existing UI pending markers, unlock unknown actions, or resend downstream work. UI reconciliation remains a separate change that must preserve exact-operation and navigation/scope guards.
- Regression gates: `hearing-durable-storage.test.ts`, `hearing-decision-receipt.test.ts`, `hearing-decision-receipt-routes.test.ts`, `hearing-storage-access.test.ts`, `hearing-storage-boundary.test.ts`, and the existing hearing writer/process/client suites. Cover interrupted staging, canonical deletion/corruption, tmp cleanup, real process restart and concurrent replay, historical receipts, production surface identity, missing/corrupt policy, and real secureIO cross-tenant/tier denials.

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
- **Streaming completion includes output drain.** A child's `exit` does not mean stdout has
  reached EOF. STT/TTS adapters finish on `close`, drain queued output on successful completion,
  and propagate nonzero exits, spawn failures and input-pump errors to the async consumer,
  including a consumer already waiting for its next chunk. Regression gates:
  `shell-streaming-stt-bridge.boundary.test.ts` and `shell-streaming-tts-bridge.test.ts` use real
  subprocesses and delay consumption until the worker exits.
- **Selection requirements reach execution.** Streaming STT forwards the requested language per
  transcription through normal, replay, barge-in and calibration paths; shell adapters translate
  it into the worker environment without mutating process-wide defaults. Gate this with the
  realtime loop, calibration and shell STT regression tests.

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

**Surface preview ownership.** A response belongs to the current visible selection, not to the
last request that finishes. Select synchronously, clear old data immediately, and keep Close usable
while loading. Abort on replacement/dismissal and also guard every success, error and finalizer
with request generation; cancellation alone cannot stop an already-read body or an uncooperative
request. Bind the selection to its entry ID, artifact revision and current member context. Close
when actual rendered visibility changes (including derived tenant filters, deferral or a failed
queue read), when navigation hides the page, and on unmount. Verify a matching receipt and bound
the request lifetime. Exercise delayed fetch/body/error permutations, same-entry reopen, auth
revision changes, unchanged summary refreshes and timeout recovery in
`presence/displays/concierge/test/outcome-preview-ui.test.ts`; history must stay untouched.

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

**Query performance: bound work before relaxing time budgets.** When a query smoke
test exceeds its cross-platform budget, retain the failing timing evidence and
count expensive operations on a deterministic tied-score fixture. Ranking
comparators must not reload scoped settings or recompute the same hint's metadata
on every comparison. Keep reuse local to one query, keyed by hint identity; load
weights lazily only when a lexical tie requires metadata. Pin call counts, zero-score
ties, per-query scope/settings refresh, and document aggregation in tests, alongside
the unchanged latency budget. `libs/core/knowledge/knowledge-index.test.ts` enforces
this contract; a faster Linux run alone is not evidence that macOS CI passed.

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
  - **A liveness threshold on a fixed wall-clock window.** `expect(ops).toBeGreaterThan(N)` where
    `ops` is counted inside a fixed `ms` window is load-sensitive: a shared CI shard can run the
    op ~10× slower and still be correct (`secure-io.symlink-canonical.test.ts` fell to 29/50,
    2026-10). Make the exercise helper repeat the window until the floor is met, capped by a
    bounded deadline (`minOps`/`ms * 4` in `hammer`), so a genuinely dead op still fails while a
    merely slow runner passes. Keep the semantic assertions (`refused`, `torn`, `otherErrors`)
    strict — only the liveness floor tolerates load.

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
- **Prune runtime floors before source traversal.** Source boundary tests enumerate code roots and exclude `active/`, `knowledge/`, `customer/`, `vault/`, generated output, dependencies and hidden directories before recursively walking. Filtering after a full checkout walk still reads tenant runtime trees and makes a small source check depend on retained data size. The process-boundary governance test enforces this source-only traversal.
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
- **A protected tier root is not enumerable — probe the bound partition.** When a path lands
  under `tenant_scope.protected_prefixes` (`active/missions/<tier>/`,
  `active/archive/missions/<tier>/`), a tenant-bound process can no longer `safeReaddir` the
  tier root: `existsSync` reads "missing", `lstat`/`readdir` throw `scope_invalid_prefix`, and
  any enumerator that lists the root silently sees nothing — or crashes the sweep that calls
  it. Every enumerator of a mission tier root must route through
  `missionTierScanDirs` (`libs/core/owner-scope.ts`), which returns `<root>/<bound>` for a
  bound identity on protected tiers and the whole root otherwise — never a hand-rolled
  try-readdir/probe-bound fallback per site. Flat (untenanted-dir) entries are unreachable by
  enumeration under a bound identity by design; they stay resolvable by id and through
  recorded ids (`project.active_missions` → `loadState`). Verify by binding a tenant via
  `scope.env` or `KYBERION_TENANT` (both flow through `resolveProjectScope` — env alone is
  NOT the only binding) and running the sweep: the chronos daemon's await-state sweep was the
  incident that proved this (2026-10, `boundTenant`/`missionTierScanDirs` consolidate the fix).
  The defect recurred in enumerators that predated the rule — `system:list_missions`,
  `watch_tenant_drift`'s confidential walk, `virtual_office.listMissionDirs` — surfacing as a
  **golden-gate drift on live checkouts** (`baseline-check`/`vital-check` step failing with
  ROLE_VIOLATION only where `active/missions/{confidential,personal}` exists). A second,
  quieter symptom: post-partition layouts (`<tier>/<tenant>/<id>`) made flat enumerations
  report tenant directories as missions. Coverage:
  `libs/core/mission/mission-tier-scan.test.ts`,
  `scripts/watch_tenant_drift.test.ts` (bound-partition probe),
  `libs/actuators/system-actuator/src/system-pipeline-path.test.ts` (bound `list_missions`).

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
  - **Explicit Codex call permissions must survive the backend boundary.**
    `CodexCliReasoningBackend.prompt` / `delegateTask` project `profile` or
    `capability_profile` through the same provider permission resolver as the query runner.
    `permission_mode: readonly` narrows an implementer to explorer; an explicit explorer
    stays read-only even if edit was requested. Conflicting profile aliases, unknown tiers,
    unsupported full mode and the unsupported planner projection fail before query execution.
    `route_profile` selects reasoning, not authority. Keep calls without explicit constraints
    backward-compatible and keep ambient sandbox restrictions authoritative. Cover this handoff
    with mocked backend tests and query argv tests; read-only is not a tool-less guarantee.
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

**Execution-ledger receipts.** Append the ledger bytes and their provisioned/verified
whole-file receipt under the same fenced writer lease. An initial empty-file receipt
does not authenticate later rows. Ordinary append and resume must reject a changed
receipted prefix; never clear receipts or replace the ledger to make replay pass.
For the legacy writer that recorded only the initial empty ledger, use
`pnpm mission repair <ID> --note "repair legacy empty-ledger receipt"`, then
`pnpm mission resume <ID>`. Repair accepts only the sole matching initial empty
receipt pair and complete JSONL rows with valid mission/scope identity. It retains
every ledger byte, appends a current receipt, and records the migration in mission
history; it cannot retroactively authenticate historical appends. Other hash
mismatches and pending writes remain blocked for investigation.
The canonical `writeMissionNextTasks` writer must also refresh its receipt on every
task transition. If an older task file has a stale receipt, re-record the actual
evidence or independent review through `record-evidence` / `review-task` after
fixing the writer; never hand-edit task status or rebaseline arbitrary artifacts.
Replay reads journal, receipts and target hashes under the same mutex as writers,
without changing the lease fence or metrics, so an active append is not reported
as corruption.
Gates: `mission-orchestration-journal.test.ts`, `mission-team-binding.test.ts` and
`mission-lifecycle.test.ts` cover append integrity, refusal after tampering, explicit
legacy migration and lifecycle recovery.

Video gates that derive approval scope through strict `findMissionPath` must register
the caller as `scope-derivation` in `tests/mission-lookup-boundary.test.ts`. Run that
boundary test with the production regression suite before publishing.

**Video production preflight.** A phase exit gate alone does not defer the next
task under the default warning rollout. For generated video, wire validated
spec/scene planning, current prototype acceptance, selected-take lineage and
remaining spend to phase entry gates before generation, assembly, repair and
promotion. Reuse command_succeeds with the typed video evidence checker; keep
semantic quality decisions with the existing independent review.

Approval request helpers write their own request artifacts, never
prototype-acceptance.json or video-playback-approval.json: these are task-owned
decisions. Bind image decisions to source bytes/revision/scene intent and playback
decisions to the final render plus evaluation; reject pending, expired, revoked,
cross-scope or stale decisions. A changed scene/take requires corresponding
evaluation evidence. Stage checks stay read-only and never create an approval.

Regression gate: scripts/lib/video-production-evidence.test.ts exercises the real
persisted generation entry gate, approval/version invalidation, cost and attempt
limits, lineage/review changes, non-generated pass-through, and mission path
confinement. Mission catalogue expansion tests pin phase dependencies and gate
wiring. Provider-side spend reservation remains a separate capability.

**Closure observations:** `completed` can precede delivery, retrospective, or independent review
evidence. Read-only status and triage must inspect the strict task graph before suggesting
`finish`; they must not translate this lifecycle label directly into archive advice. Missing or
malformed boards remain unknown. Review-kind tasks (including phase-only and unprofiled tasks)
require current, mission/task-bound receipts and independent review proof. Use `record-evidence`
for direct work and `review-task` for reviews; never repair tasks during a read. `archived` stays
terminal. An advisory finish candidate is neither authorization nor merge/deployment proof, and
the finish facade revalidates all gates. Regression gates: `mission-flow-projection.test.ts` and
`mission-triage.test.ts`; hash an isolated fixture tree around real status/triage CLI reads.

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
    `.stale-*` tomb when the base side is refused as a hard link — only a tomb that is the
    record's own inode (`LockIo.sameFile`, checked before and after the read), never a leftover
    tomb from an older recovery — so `releaseLock` and lock inspection see the live owner during
    the put-back window. A tomb may move only within its
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
- **Authorize what was opened, not only what was checked.** The path check runs before
  `open(2)`, which follows symlinks, so a link flipped in between hands over another file — a
  `knowledge/personal/` file has one link, so no hard-link rule fires. Every in-place open
  (`openInPlace`: read, range, tail, append, open-for-append, fsync, copy source) therefore vets
  the descriptor (`vetOpenedFd`): the opened file's own location — `/proc/self/fd/<n>` on Linux,
  otherwise the re-derived canonical path whose leaf (not followed) must be the inode held — is
  re-authorized unless it is exactly the canonical path the caller's check approved, then the
  hard-link rule runs on it. The identity pin covers the checkout root itself (a repository walk
  starts by listing it). In-place opens are non-blocking with `O_NOCTTY` and refuse anything but
  a regular file, so a FIFO (or a link flipped to one) cannot hang the caller. Range and tail open
  no-follow. Errors from these opens and stats carry only the errno (`open failed (ENOENT)`),
  never an absolute path.
- **Hard-link churn cannot pass the link count.** An attacker that loops
  `rm name; ln knowledge/personal/…/secret name` makes the first `fstat` see `nlink=1` while the
  name is unlinked and the location check pass once it is relinked. `vetOpenedFd` therefore
  re-`fstat`s after the location check and, without `/proc`, refuses any change between the two: inode, link
  count, or a ctime that moved without a size change — a data write moves the size as well as
  ctime and mtime, while `link`/`unlink` move only the ctime and `utimes` can stamp
  ctime == mtime without writing. A fully unlinked inode (`nlink` 0) is exempt: no name reaches
  it, so it cannot be a protected file. `vetOpenedFd` then judges hard links on that last
  `fstat` and requires the name opened through to be still linked: on Linux a `/proc` entry
  ending in `(deleted)` is served only while the inode itself has `nlink` 0 — the atomic
  write-then-rename replacement, whose stale content is exactly what the caller opened — never
  re-derived from the path. `unlink(2)` drops the link count before it marks the name deleted,
  both under the parent directory's lock, so for a single-link file whose ctime moved within
  the last second (an unlink in progress has just set it) the parent is read once first —
  `getdents` waits for that lock — and the entry must read the same afterwards. Off Linux the
  canonical leaf must still be the inode with the same link state, after the same parent read
  for a recently changed file. With `/proc` the ctime is not compared at all: the `(deleted)` mark
  after a settled parent already proves the name was counted, and on Linux 6.x a data write can
  leave ctime ≠ mtime (multigrain timestamps: about 1 in 800 `fstat`s under a busy appender), so
  a ctime rule refused concurrent appenders and chmod/utimes writers. An inode left with no name
  while being judged (an atomic replace landing mid-vet) is served at the name it had, on either
  path. An opened directory must still be what the path names (`stat`, same inode): under a
  rename-over loop on ext4 an `open` of `dir/name` can, rarely, return `dir` itself, and a chmod
  or listing would otherwise land on the parent. Appends are vetted this way before any byte is
  written. Always settling single-link files cost about 20% per read, so the one-second gate
  stays (residual below). Cost on the CI VM: about +5% per in-place read or stat, about +15% per
  append to a file changed in the last second.
- **Appends create only inside the directory that was opened and authorized.** An append opens
  without `O_CREAT` first. A missing entry is created with `O_CREAT|O_EXCL|O_NOFOLLOW` (never
  through a leaf link) after the parent directory is opened and its own location authorized for
  the new name, so a parent component flipped to a link after the check cannot redirect it. On
  Linux the create goes through that held descriptor (`/proc/self/fd/<n>/<name>`, an `openat`); on
  macOS it opens the authorized physical path with `O_NOFOLLOW_ANY` (`0x20000000`, not exported by
  Node; it replaces `O_NOFOLLOW`, since open(2) rejects both together with `EINVAL`), which fails
  if any component is a link at create time. Elsewhere — and on Linux when `/proc` is not
  mounted (a sandbox) — there is no `openat`: a create through a linked parent directory is
  refused, and the parent must still be the inode held afterwards.
  When a concurrent appender wins the create (`EEXIST`), the loser opens that file without
  `O_CREAT` and appends, so no line is lost; a dangling leaf link is refused, even when its target
  would be allowed. A created file whose vetting fails is left in place, empty, and the call
  throws — secure-io never deletes it by path, because a flipped parent could redirect that
  unlink onto a protected file.
- **chmod only through a descriptor.** `safeChmodSync` opens files and directories
  non-blocking, vets the descriptor and `fchmod`s it. Sockets, FIFOs and devices are refused:
  Node has no `lchmod` on Linux, so a chmod by path could follow a leaf flipped to a link onto a
  protected file. A process that needs a private Unix socket binds it under a restrictive umask
  (the agent runtime supervisor binds with `umask 0177`, so the socket is created 0600, and
  restores the umask in a `finally`). The umask is process-wide: threadpool file work that races
  this one synchronous `listen()` at daemon startup would also be created under it.
- **Listings and stats are pinned too.** `safeReaddir` lists the directory it opened and vetted
  (`readdirVetted`: `/proc/self/fd/<n>` on Linux, an identity-pinned path otherwise); a pin that
  does not hold throws. `walk` / `getAllFiles` yield nothing only for a missing root (`ENOENT`,
  `ENOTDIR`) and rethrow every other failure to list it, so a refusal never becomes `[]`; scope
  offboarding's directory listing does the same, so `verifyScopeOffboarded` never reports a
  refused listing as clean. The checkout root is pinned by `stat`, so a `KYBERION_ROOT` that is
  itself a symlink still lists off Linux. Linux CI runs the portable branch through the
  `setProcFdLookupDisabledForTesting` seam, and a Linux host without `/proc` through
  `setProcFdRootForTesting`. `safeStat` and
  `validateFileSize` stat through a vetted non-blocking descriptor (`statVetted`; sockets, FIFOs
  and devices fall back to the leaf-identity pin). A target outside the repository is pinned only
  under a registered vault mount (`vaultTargetIdentity`). Denial messages name only the caller's
  path — never the resolved location or a tier-guard reason that embeds it — but keep the
  reason's classification (`[RESOURCE_SCOPE_DENIED]`, `[POLICY_VIOLATION] tenant.scope_violation`;
  `denialCode`), so callers that classify on the code still see it. Errnos libuv leaves unnamed
  (macOS `EOPNOTSUPP` from opening a socket) are classified by number. Cost on the CI VM:
  about +45 µs per read or stat, none for appends to an existing file (their canonical path is
  passed through).
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

- _Check-to-use race._ In-place opens and stats are pinned to the descriptor (above) and
  `safeWriteFile` re-verifies its directory before the rename. Path-only operations that cannot
  hold a descriptor (rename, unlink, rm, mkdir, `safeLstat`, `safeReadlink`) still
  act on the literal path after the check; a concurrent swap can redirect one such operation. On
  platforms without `/proc/self/fd` the fallback pin re-derives the canonical path, so an
  attacker would have to win two consecutive races.
- _Append creates off Linux and macOS._ Without `openat` or `O_NOFOLLOW_ANY` (Windows, the BSDs)
  the create is by path from a parent that was symlink-free at the check; a real parent directory
  swapped for a link between the check and the create can still leave an empty file in another
  directory (the call is refused, nothing is written, nothing is deleted). "Never creates through
  a link" holds for every component on Linux and macOS.
- _Hard-link churn off Linux._ Without `/proc` a name is identified by path, link count and
  ctime; a filesystem with coarse ctime granularity lets a link and an unlink inside one tick go
  unseen, an attacker that can also write the target can move its size along, and a name held
  on a protected inode for the whole open-and-vet window — a park, not a churn — is
  indistinguishable from a file that was always there. A ctime that moved between two `fstat`s
  is re-compared from the later one, up to eight times, so a file chmod-ed or touched as often as
  every millisecond is still served; a writer that never pauses leaves no quiet window and is
  refused there. Linux is pinned by the
  `(deleted)` marker and is not affected.
- _A single slow unlink on Linux._ A hard link older than one second, unlinked exactly while a
  read runs, is not settled (ext4 drops the link count before it stamps the ctime). Churn — every
  repeated link and unlink — stamps the ctime and is settled.
- _Hard links to files outside the repository_ (vault targets) are not detected. Path-only helpers
  (`safeLstat`, `safeExistsSync`, `safeReaddir`) reveal metadata of a hard-linked file but no
  content.
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

CLI daemons use the same secure-io boundary for runtime files. Borrow log descriptors through
`withSafeAppendFile` so spawn failures also close them; redirect detached stderr to that descriptor
instead of appending the same log line again. Run `libs/core/security-boundary.contract.test.ts`
alongside the CLI tests: adding a raw-fs exception to an import baseline does not satisfy this gate.

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
SUDO pnpm-store reads, ENOENT code, direct symlink flip between check and open for read / range /
tail / stat / size, chmod of a file or directory, append-create through a dangling link and
readdir (bounded races), append-create through a flipped parent and through a linked parent per
platform, FIFO reads that must not block, denial messages without the resolved location but with
the guard classification, `validateFileSize` tier and hard-link guard, directory
swap between check and temp open, single probe registration, `node_modules` read exemption,
legitimate links in scope, Vitest remap, vault reads), `libs/core/secure-io.symlink-root-alias.test.ts`
(checkout behind a linked prefix), `libs/core/foundation/lock-utils.tomb-release.test.ts` (release
during the put-back window and with leftover tombs, against the real secure-io lock IO) and the import boundary in
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
A silent `PTY_ENGINE ... falling back to ChildProcess` warning means sessions
run without PTY semantics (no resize, tty prompts like `ssh` password reads
break, output is block-buffered). On macOS the recurring cause is the
node-pty prebuilt losing its execute bit —
`chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-*/spawn-helper`
restores it; verify with a `resize` op, which only succeeds on a real PTY.
When adding probe scratch with `sharedTmp()`, register the exact call count and
the consumable diagnostic purpose in `shared-tmp-allowlist.json`, then run
`tests/shared-tmp-ratchet.test.ts`. Preserve durable conclusions in mission
evidence instead of relying on scratch files after their retention window.

---

### Native desktop permission and input checks

Probe Accessibility, Screen Recording and each Apple Event target separately without
prompting. Unexpected compiler/process/API failures are unknown, not denial. Do not infer
AX trust from reading a process name, Chrome permission from System Events, or screen access
from aggregate bridge readiness. Keep the source-specific result visible.

Compile the macOS helper from the exact bytes used by its cache key. Use the canonical
system cache floor, exclusive temporary files, a process-shared build lock and atomic
publication. Reject invalid coordinates/counts/directions before spawning; recheck AX
trust immediately before input injection. A failed native request must not become a
successful pointer receipt.

Regression gates: macos-native-automation.test.ts, apple-event-bridge.test.ts,
macos-automation-bridge.test.ts and virtual/desktop-recording.test.ts cover permission
separation, invalid/malformed input, cache publication and partial readiness. Verify native
Swift compilation and nonprompting probes on macOS. Keep live input outside these tests.

## Maintenance

When a defect class not listed here recurs:

1. Add a section with the rule, the procedure, and the gate or test that enforces it.
2. Link the section from [kyberion-development-practices](./kyberion-development-practices.md) and
   the pre-PR checklist.
3. Record the incident in the mission's retrospective.

A rule without an enforcing check is a candidate for the next gate.

## §12 Dot admission and operator digest evidence

A dispatched proposal is queued work, never evidence that its effects finished. Generic dot operations bind the tenant/dot scope, originating wake key and original proposal ordinal before publishing a deterministic WorkItem. The admitted record must survive every interruption until reconciliation. Changed semantics under an existing operation identity fail closed. A new intentional wake has a new operation key; identical work repeats only after matching successful terminal evidence. Unresolved admission, queued/running work and uncertain archived work never expire into automatic retries. Pending or rejected approval proposals retain their semantic suppression window across wake keys.

Recovery reconciles creation only. Recheck current tenant, charter, approval and gate authority before creating a missing item. Reuse immutable creation identity for existing, running, done or archived items; never reopen or retry uncertain effects. Pre-upgrade parked work binds an admission before creation; an existing legacy random-ID item is adopted only after verifying its original creation snapshot. Handoff wakes use the same action identity.

Digest completion requires a matching terminal execution receipt, current attempt identity and no superseding operator release. Missing or inaccessible evidence stays queued. Notification acceptance means durable outbox/inbox acceptance, not confirmed user delivery. Save a pending digest with frozen content in its tenant-scoped dot state directory before calling the notification port. The shared legacy ledger is metadata-only and read-only. Keep the content snapshot cutoff when delivery is delayed so later execution results remain visible. Stable delivery keys reconcile queue evidence and retained acceptance receipts; unknown external effects remain uncertain. Muted notifications settle as suppressed. Retry only definite no-effect failures, with finite attempts and age, and catch up only the newest scheduled minute inside the bounded window.

When changing these paths, run dot admission/recovery, digest/recovery and operator-notification/inbox suites, including crash-before/after-create, process races, semantic mismatch, archived work, tenant isolation, revoked authority, stale attempts/releases, missed cron, restart, mute and enqueue-before-receipt failures. Preserve intent/acceptance tombstones under review-required retention; deleting them invalidates replay protection. Keep tests isolated from live channels and run them separately from builds and aggregate gates.

## §13 Timed-out effects and executor continuation

A pipeline timeout requests cancellation; it does not prove that an already-running operation stopped. Retain the owning attempt and original declared target independently of archived status, lease expiry, charter presence, proposal priority and age. Both proposal admission and the atomic execution claim refuse overlapping work in the same tenant, including work from the same dot and work queued before the timeout. Targetless work cannot receive cross-dot target protection; adapters must declare their actual effect targets.

The trusted pipeline runner checks the current attempt, lease and halt state at each dispatch boundary and before lifecycle/step hooks. An operation already dispatched may still finish. Do not replay it automatically. Recovery requires existing authenticated, version-bound human approval after confirming execution stopped and reconciling partial effects; archive or missing process liveness is insufficient. Ordinary metadata edits cannot clear ownership. A successful trusted executor receipt or definite pre-effect failure settles only its own current attempt.

Persist the last eligible executor turn before awaiting work, and resume with its stable successor on the next sweep or process restart. Keep per-dot caps and tenant checks. The fairness bound is at most N eligible turns for a stable set of N dots across budgeted sweeps, not a wall-clock deadline: an individual operation may exceed the sweep budget. Diagnostic scoped passes do not modify the global cursor.

Treat a missing continuation differently from corrupt or unreadable evidence. Only an ENOENT metadata result initializes normal scheduling order. Existing malformed JSON, falsy values, invalid shape, non-regular files, metadata failures and read failures (including disappearance after a successful metadata read) stop normal sweeps before new claims, execution ports or cursor writes. Preserve the original evidence; never use an optional JSON reader that turns these failures into an initial-order reset. Diagnostics share the strict reader and sanitize errors without exposing cursor identities or raw parser/path details. Revalidate under the existing turn-recording lock before writing, because the earlier ordering lock has already been released. This is not a filesystem compare-and-swap against noncooperating external writers.

An operator investigating a blocked cursor should preserve its bytes and inspect its provenance and filesystem accessibility before choosing a governed recovery. Do not delete, recreate or auto-reset the cursor. This protection is not a global execution freeze: already-running work may finish, existing authenticated release processing remains independent, and scoped diagnostic first-job passes do not use the global cursor.

Gate with dot-executor-ownership.integration.test.ts, work-effect-ownership.integration.test.ts, the existing human-release integration suite, and tests/fixtures/dot-executor-behavior.mjs. Run the fixture in cursor mode for syntax, null, false, shape, directory and late-corruption (late) cases with --expect-blocked; fault-inject metadata/read errors in the focused integration suite. Measure actual isolated writes, conflicting commits, later steps, attempts, preserved cursor bytes and restart order; do not substitute mocked invocation counts for effect evidence.

## §14 Mission-flow observations are advisory

Mission status and triage share `collectMissionFlowProjection`. Keep this path read-only: no runtime startup, model calls, approval expiry writes, task repair, gate execution, or lifecycle mutation. A candidate is neither permission nor completion evidence; the existing governed facade must revalidate state and authority when executing it. Legacy triage lifecycle categories and command examples are compatibility hints, not readiness decisions.

Missing or malformed task boards must stay unknown rather than becoming zero pending tasks. Reuse the dispatcher's normalized graph validation and exact dependency-completion rule. Preserve recorded gate timestamps, distinguish unknown chronology, and do not turn a historical pass or override into current authorization. Structural completion checks may expose evidence gaps; they cannot establish external merge or deployment.

Associate approvals only through matching explicit scope, never a mission-name-only legacy record. Pending and expired requests are observations; an approved record is not thereby usable, and a successfully applied request must not later demand another decision merely because its expiry passed. Report incomplete legacy coverage. A team roster or historical launch is not runtime readiness; leave unobserved readiness unknown.

Regression gate: run `libs/core/mission/mission-flow-projection.test.ts` and `mission-triage.test.ts`, then execute the status read model and CLI on isolated synthetic stores. Compare recursive file hashes before and after reads, check repeated and transitioned observations, and distinguish real-store evaluations from in-memory approval fixtures. Verify the existing terminal-HUD consumer receives the same next-action projection.

### Forward-only event continuation

Legacy event intake inspects only the latest 2,000 accepted rows / 4 MiB and uses
a 24-hour initial lookback. The dot status command now reports scan coverage;
history outside that window is not an exact lost-event or pending count.

To adopt durable forward continuation, an operator must first pause the charter,
stop all supervisors and competing charter editors, and review existing effects.
Then run: pnpm kyberion dot event continue <dot_id> --confirm-quiescent.
The command preserves draft/paused status and captures the current complete-line
EOF under the intake lock. It writes the continuation snapshot before declaring
the activation ID in the charter. Review dot status and separately use the
normal activation ceremony. This is not historical recovery: rows before the
captured boundary remain untouched.

Per-scope snapshots under the existing dot state floor retain at most 128 matching
pending events; each scan reads a batch of at most 4 MiB, plus fixed-size
256-byte checkpoint-anchor reads, and inspects at most 2,000 lines per sweep.
Capacity stops scanning and never evicts pending work. Offsets advance only with
atomically persisted pending entries; merely offering a wake never acknowledges
it. Scope identity includes tier, tenant, organization, project and dot ID, while
the authenticated event source remains tenant-wide.

A claim is persisted before provider invocation. A crash, timeout, non-complete
goal result, or unresolved output after dispatch retains an ambiguous attempt.
There is no automatic lease expiry or re-dispatch. Known failures before dispatch
retain normal backoff. Matching terminal wake evidence consumes the event; an
authoritative terminal runner record can reconcile an offered event, but a generic
duplicate receipt cannot. Already-held attempts require matching wake evidence or
separately authorized operator investigation; no automatic reset command is provided.

Kyberion's wrapper retries/failover and Anthropic request retries are disabled
lexically for these attempts. This does not control the internal behavior of
external CLI runtimes or promise exactly-once downstream business effects.
Downstream operations still need their own idempotency. Existing wake-receipt
replay remains unchanged and is not bounded by the event-reader limits. Atomic
snapshot writes do not establish a tested sudden-power-loss durability guarantee.

Missing/malformed checkpoints, orphan snapshots, changed triggers/scope,
source rotation/truncation, changed anchors, malformed complete rows and oversized
rows stop continuation. Do not delete or reset evidence to resume. Preserve the
charter, source, checkpoint, wake/runner receipts and downstream effect evidence;
a separately approved recovery must reconcile the exact activation/event/attempt
before any replay decision. A trailing incomplete source line waits for completion.
Status reads inspect recorded state/continuity without scanning every unread row
or establishing process liveness.

Regression gates: real distinct-payload acceptance above 2,000 rows, byte cutoff,
bounded pending pressure, new-process restart and competing process claims,
stale offers, pre/post-dispatch failure, partial wake-tool effects, terminal
receipt correlation, tenant/full-scope isolation and fail-closed state/source loss.
Never invoke real providers, notifications or resident daemons for these fixtures.

## §15 Append-only JSONL stores

**Rule.** A `.jsonl` file that only ever grows by appending is never expired by the
janitor's mtime TTL — the append keeps its mtime fresh forever. Every such store
needs one of three declared lifecycle actions in the retention catalog, or an
explicit `review_required` note naming what bounds it.

**Procedure:**

1. Pick `rotate` (pure event/log files), `compact` (versioned keyed state, requires
   `compact_key`), or `archive` (compliance evidence that must never be unlinked —
   expired files move to `active/archive/<repo-rel>`). See
   [append-only-store-lifecycle](./append-only-store-lifecycle.md) for the decision
   table and reader contract.
2. Never embed unbounded history inside a versioned record — cap arrays like
   `WorkItem.attempts` at write time and keep the full history in the event feed.
3. After changing a store's shape, run the janitor dry-run and check the
   `Append-Only Stores` section of `storage-janitor-report.md`.

**Gate:** `pnpm check -- --only runtime-store-retention`; janitor report
`uncoveredRuntimeFiles` must stay empty for declared stores.

## Outcome settlement must resume the resident Dot loop

**Rule:** Executor completion and goal achievement are separate events. A delayed
outcome verdict must be able to wake its owning Dot without relying on a future
cron, an inbox channel declaration, or an in-memory callback. Use the scoped
outcome ledger as continuation evidence and the normal wake ledger for receipt,
backoff and circuit handling; never weaken authority or budget checks.

**Procedure:** Coalesce the valid append-ordered outcome identities into a scoped
watermark. Duplicate action verdicts are immutable and cannot inflate a progress
streak or replay a consumed wake. A newly eligible identity, including delayed
arrival or clock-skew recovery, changes the watermark. Diagnose stagnation per
KR/signal in measurement order; two non-improving outcomes request replanning,
an already-met target requests monitoring, and unknown measurements request
measurement repair. Preserve outcome and wake evidence during recovery; do not
delete receipts to force another execution. Keep tenant metric prose out of
shared wake details. Replanning guidance does not authorize new effect classes.

**Gate:** `pnpm exec vitest run libs/core/dot/dot-progress.test.ts` covers duplicate
and late evidence, clock-skew recovery, an append during a wake, persisted
consumption, tenant separation, circuit/backoff, goal satisfaction, measurement
repair, and authority/budget enforcement. Run the adjacent outcome/runtime,
admission/recovery, digest/recovery and inbox suites when changing this path.

## Workflow reuse completion assessment

**Rule.** Completion-time workflow assessment must pass the governed wisdom LLM
profiles into the adaptive runner. A successful mission finish does not prove
that assessment ran: inspect `workflow-reuse.json` and distinguish `not_assessed`
from a validated `needs_review` candidate.

**Procedure.** Exercise the ordinary retrospective with a real configured provider.
Transport arbitrary ADF dictionaries as JSON text in strict provider output schemas,
then parse and validate through the internal schema, ADF, guardrails and dry-run
checks. Verify stable candidate identity on unchanged evidence. Replay remains
subject to project-trust approval; never infer execution authority from candidate
generation or dry-run success.

**Gate.** `mission-workflow-reuse.test.ts` covers governed profile forwarding,
malformed transport JSON refusal and stable retries. A live probe must additionally
record provider success, queue handoff and the separately approved replay result.

## §14 CLI hook continuation loops

**Build-safe hook startup.** Provider hook commands enter through
`scripts/provider_hook_entry.mjs`, which has no built-runtime dependency. Canonical
build cleanup may temporarily remove the entrypoint or an imported dist module.
During that window, notification events report a bounded diagnostic on stderr and
end successfully; Claude/Gemini tool-authorization events return a native deny.
Once loaded, the provider runner retains its own output and exit semantics.
Regenerate managed commands with `pnpm generate:provider-hooks`; preserve other
hooks and settings, including permissions. The generator owns only the exact
Claude settings output in addition to its existing Codex/Gemini outputs.
Gates: `provider_hook_entry.test.ts`, `generate_provider_hook_configs.test.ts` and
`claude-hook-wiring-contract.test.ts` cover missing runtime imports, native deny,
normal stdin forwarding and idempotent wiring migration.

**Rule.** A coordination notification must not start another model turn or reply to itself.
`Stop` is telemetry only; never emit review instructions or `decision: block` there.
Exit immediately when `stop_hook_active` is true. Release leases on `SessionEnd`, not per-turn Stop.

**Procedure.** Pull handoffs at session start, user input, and supported tool-completion boundaries.
Persist notification receipts per participant under the existing Co-Session store, serialize receipt
updates across hook processes, and keep ack an explicit agent action. Preserve unrelated user hooks
when regenerating wiring. Do not change hook trust records or invoke an LLM from a hook.

**Gate.** `scripts/codex_cli_hook.test.ts` exercises repeated tool events, own-message filtering,
separate CLI instances, bounded batches, Stop silence and SessionEnd release.
`libs/core/provider/co-session-hook.test.ts` checks interleaved hook delivery;
`libs/core/provider/claude-code-hook.test.ts` checks recursive Stop silence;
`scripts/generate_provider_hook_configs.test.ts` checks idempotent generation and preservation.

## Hearing completion read recovery

Saved handoffs must remain discoverable after a fresh page load. The hearing GET projects a completion only after checking the persisted mission and its exact alignment approval, or the inventory entry in the viewer-derived scope. Strip unchecked completion identifiers from the wire record; missing, partial, deleted, malformed or unauthorized targets produce a non-actionable marker, not a new confirmation action. Keep canonical navigation configuration and scope narrowing; never invent a surface port or repeat a mutation to recover a link.

The Ask client accepts this read model only through its current hearing session/scenario/navigation gate. On scope or page retirement, remove old completion identity and links until a new authorized read restores them. Preserve unresolved in-flight mutation guards, and discard late callbacks from the retired context. This does not add mutation timeouts, retries or exactly-once guarantees.

Regression gate: hearing-completion.test.ts, hearing-routes.test.ts and ask-hearing-completion-client.test.ts, plus the existing hearing/read recovery suites. Verify POST success and reload for both mission and inventory in an isolated loopback fixture, check no repeated POST, unavailable targets, selected scope and stale/unsafe links.

## Hearing decision uncertainty

Decide is a mutation even before a handoff is created. Persist a minimal session-scoped pending marker before sending, guard every hearing mutation, and distinguish a known pre-write rejection from an unknown outcome. A deadline, network failure, malformed response or server error does not prove that nothing was saved. Never resend automatically or unlock an uncertain decision from GET presence/absence, timestamps, or an unrelated completion destination. Keep a visible ordinary-conversation exit while retaining the affected session marker; unavailable storage must fail closed before dispatch.

A valid response from the exact outstanding POST may settle only its own marker. Navigation, shell/scope changes and BFCache retire publication; late callbacks must not overwrite newer views or clear another action. Reload retains uncertainty. A verified prior completion can remain a read-only destination, without representing proof of this decision attempt. Only a versioned exact-operation reference can use the durable receipt recovery described below; older markers remain a no-resend guard and cannot be upgraded by inference.

Regression gate: ask-hearing-decision-client.test.ts plus hearing completion, answer recovery and read recovery suites. Exercise repeated clicks, explicit rejection, deadline and ambiguous errors, storage failures, reload/BFCache, stale callbacks, normal-conversation escape, and GET results that must not unlock pending decisions. Verify the same flows against the current static UI with synthetic loopback APIs; do not mutate a live tenant for QA.

## Exact browser hearing decision receipt recovery

Persist a version-2 marker containing only the exact versioned operation (ID, scenario and requirements revision), conversation ID and scope before POST. Never persist private answers, actor data or the record payload. Recovery is an explicit GET-only action: read the current hearing, then query the exact operation receipt in the same authenticated scope. The server binds the receipt to principal, scope, member and source; the browser additionally matches the exact operation, session, requirements revision, canonical human actor ID (user:<member_id>), decision timestamp and record revision against the fresh read. A generic GET, completion link, 404 or superseded receipt alone never releases the marker.

A recovery check takes ownership from the original POST callback, including any late success or rejection after its deadline. Retire read publication on page, shell, scope, conversation or storage changes. Recheck marker ownership immediately before clearing it. A successful check restores only a current decision and its validated completion read model; handoff and inventory remain explicit user actions. Legacy references have a readable ordinary-conversation path, with no guessed operation or automatic resend.

Regression gates: ask-hearing-receipt-client.test.ts, ask-hearing-decision-client.test.ts and hearing-decision-receipt-routes.test.ts. Feed the real durable route responses through the browser client harness, including response loss after commit, and verify read-only recovery leaves record bytes unchanged. Include delayed original POST after superseded proof, canonical human actor IDs, duplicate checks, read timeout/late success, storage loss/replacement, navigation/BFCache retirement and completion destinations. A harness pass is not rendered-browser QA; report browser access or runtime startup blocks separately.

## Hearing handoff uncertainty

Mission and inventory handoffs need the same bounded wait and no-resend discipline as earlier hearing effects. Persist a minimal session/scope/conversation/scenario/kind marker before dispatch, including a local operation identifier for ownership only. A deadline includes JSON parsing; network errors, malformed success and server errors remain unknown. Do not label them as a confirmed failure or invite another submission. Storage failure blocks dispatch. Preserve bounded conflict explanations and allow explicit pre-write rejections to release only their own guard.

The authenticated completion GET proves an existing authorized destination, not the exact handoff attempt. An explicit check may expose that destination read-only, but must retain the unknown marker and block every hearing mutation. Never infer nonexecution from missing results, or confirmation from a generic ready destination. The newer check retires original POST settlement; navigation, scope, conversation and storage changes retire publication. Keep an ordinary-conversation exit available. Displayed-decision revision binding is a separate server contract and is not supplied by these client markers.

Regression gate: ask-hearing-handoff-recovery-client.test.ts with completion, decision, receipt, answer and read-recovery suites. Cover both endpoints, hung headers/JSON, ambiguous errors, malformed success, reload/BFCache, duplicate checks, GET timeouts and destination validation, late original callbacks, marker replacement/loss and storage failures. A VM harness does not substitute for rendered-browser QA.

## Automated mission gate advancement

Automated owners use `mission_controller gate-pass <mission> <stored-gate-id> --machine-only`. This path evaluates with `humanConfirmed:false`, rejects missing or failed stored checks and raw `human_override` / `reviewer_approved` assertions, and never falls back to a file or legacy override. A real approval must be verified by its governed evidence check. Gate tests must assert that rejection produces no phase advancement, task completion or activation. Continuous-owner tests additionally pin the alignment brief and prove cancellation stops controller descendants before the owner reports settlement.

The legacy operations-halt API's `rootDir` option is an explicit **flag file path**, not a checkout directory. Callers that operate on an alternate repository root resolve `active/shared/runtime/governance/operations-halt.json` within it before calling the halt reader. Continuous-owner tests exercise the default reader without a stub for both absent and engaged flags; passing a directory must never silently disable the whole owner lane.

**Scratch cleanup is job-scoped.** `pathResolver.rootResolve` accepts one relative-path argument; compose the whole job path before calling it and typecheck that call. Tests remove only the specific files they created, or assert both the exact unique basename and parent before any job-directory cleanup. `safeRmSync` rejects recursive deletion of the shared `active/shared/tmp` root (including normalized aliases) before native removal. The scratch-root guard regression mocks native removal and verifies it is never invoked for root targets.

For the cause analysis and reusable testing procedure, see [testing-scratch-cleanup](./testing-scratch-cleanup.md). The shared tmp floor remains disposable; this guard limits individual cleanup scope rather than promising tmp persistence.

## Displayed hearing handoff freshness

A handoff must carry the exact decision the operator viewed. Project a versioned semantic snapshot inside the sanitized hearing record and capture it before dispatch; never fetch a newer snapshot at click time or substitute a current server record when the client proof is missing. The validator binds the server-resolved principal, member and source, canonical tenant/organization/project/tier scope, session, scenario, requirements revision/content, and the current decision. It is a freshness validator, not an authorization capability: authenticate every request and authorize completed destinations through the ordinary completion read model.

Every newly accepted decision, including legacy empty-body decide calls, records a monotonic decision revision. Pre-upgrade missing revisions mean zero. Exact decision replay, canvas metadata, reservation and finish preserve that decision identity. Reject a stale validator before model decomposition or controller preparation, then retain the semantic decision CAS inside the reservation lock, including revision and operation ID. This catches a same-actor, same-timestamp redecision during asynchronous preparation. Re-resolve the initiating member after asynchronous preparation and reject removed or remapped identities before reservation. GET must not migrate or backfill legacy records. Verified repeats return the existing authorized destination; partial, mixed, pending or unauthorized destinations never become a replacement effect.

Missing/malformed proof is a pre-write rejection. A stale 409 keeps the existing client no-resend guard; this contract does not turn a completion GET into proof of an exact uncertain attempt. Keep snapshot state separate from navigation-context ownership, and copy the displayed token before storage callbacks or other synchronous reentrancy can change the view.

Regression gates: hearing-handoff-snapshot.test.ts, hearing-write-consistency.test.ts, hearing-mission-routes.test.ts, hearing-routes.test.ts and all hearing client recovery suites. Exercise old view → newer stored decision → click, same-time legacy/versioned redecisions, canvas-only advances, equivalent and changed scope sets, changed actors, authorized and unavailable replay, missing/malformed proof, repeated clicks and late responses. Run real route responses through the client harness and report rendered-browser limitations separately.

## Selected hearing destination scope

Hearing requests use the same authenticated narrowing facade as conversation requests. Tenant, organization and project query values only narrow server authority; reject malformed non-string selections and ambiguous multi-tenant storage namespaces instead of silently picking one. Missing or blank selections retain the server scope. Independent canvas requests and completion links carry the validated singleton selection. Hearing storage remains tenant/session-scoped, so changing the organization or project changes the decision proof and destination visibility, not the stored answers or session namespace.

Before a new handoff, validate the selected organization's tenant, the selected project's exact canonical parent, and its controller-required project-OS scaffold. Carry that hierarchy through the governed mission CLI, child environment, brief and persisted mission proof; revalidate scope after asynchronous inventory preparation. Never widen scope or infer a different destination after validation fails. Work inventory has no project dimension: reject project selection before preparation/reservation, explain that limitation with an actionable localized message, and retain the user's answers and selection. Clearing a selection and reviewing the new scope is an explicit user action. Known pre-write rejection may release only its own pending guard; ambiguous outcomes retain the existing no-resend behavior.

Historical handoffs are not migrated or duplicated on GET. Tenant-only legacy mission/inventory completions remain available in their original authorized tenant-wide view; selecting a narrower organization/project hides a target whose stored metadata cannot prove membership. Clearing that optional selection explicitly restores the original link when the server still authorizes the broader view. Canonical mission project relationships prove membership; conflicting flat or nested claims fail closed. A legacy parentless project relationship with no flat project or nested scope claim stays tenant-visible only; it does not prove a narrower organization/project membership. Existing stored mission IDs, including legacy IDs, remain the completion source; tenant-bound IDs apply only to newly prepared missions.

Regression gates: hearing-selected-scope.test.ts, hearing-request-scope.test.ts, hearing-completion.test.ts, hearing-mission-routes.test.ts, hearing-routes.test.ts and the hearing decision/receipt/handoff client recovery suites. Cover authorized alternative selections, malformed/foreign selections, omitted scope, wrong project parent, scoped canvas URLs, stale snapshots and exact receipts after navigation, historical read-only completion restoration, and zero effects on unsupported inventory scope. Route/store and client-harness proof must be reported separately from rendered-browser evidence.

## First-job mutation response deadlines

Bound the first-job UI wait for intake, revision, approval, rejection and unstarted-recovery mutations, including response-body parsing. Reaching the deadline means an unknown outcome, never server cancellation, confirmed failure or permission to replay. Keep the exact pending intake identity and no-resend guard; release the busy flag so an explicit read-only refresh remains available. Missing or unrelated read results do not prove nonexecution. Late original responses must not change the settled unknown state or overwrite a newer read or access-loss state.

Reuse the same deadline semantics for approval decisions and recovery. Do not abort a mutation to imply cancellation, add automatic retries, invoke an operator tick from a refresh, or weaken authenticated approval checks. On a stalled submission, retain evidence and reconcile the original request through the normal read model; report unresolved state honestly.

Regression gates: first-job-client.test.ts and first-job-approval-client.test.ts. Cover initial and revised intake, approve/reject, stalled headers and JSON, timely success and deadline cleanup, exact stored identities, no replay after repeated clicks or empty reads, read-only refresh, late responses and newer signed-out state. Exercise both controls together so the parent and approval view both unlock their read actions. A client VM harness is not a rendered browser or a live authenticated diagnostic execution; report each verification layer separately.

## Mission execution-ledger receipt integrity

`execution-ledger.jsonl` is whole-file receipted: every append MUST go through `appendProvisionedText` so `provisioned-entries.jsonl` tracks the file's real bytes. Never raw-append — unreceipted growth makes the next provisioned writer hard-stop on `provisioned_entry_mismatch` forever, blocking record-evidence, review-task, reconcile-work and finish for that mission.

Drift repair is operator-only: `pnpm mission repair <ID>` re-baselines via `receiptCurrentProvisionedText` after `validateExecutionLedgerText` proves every row parses and belongs to that mission. Rows that fail validation are real corruption, not drift — keep the hard stop; do not hand-edit `provisioned-entries.jsonl` (a receipt attesting unverified bytes destroys the evidence value).

Regression gate: `mission-team-binding.test.ts` ledger receipt cases — hard-stop on unreceipted growth, re-baseline on repair, refusal on cross-mission rows.

## Bounded Discussion execution and saved results

The browser's **single-model brief** is a distinct path: one deterministic facilitator seat, one isolated structured generation, then deterministic minutes and HTML assembly. It does not simulate multiple agents, assert panel consensus, verify the source evidence, or start a mission. The multi-agent panel remains separate; its browser preset is one round and at most nine isolated invocations. Dialogue has a finite room-lifetime budget. An isolated invocation is not an API-request count: Claude's strict adapter permits at most three internal turns for structured output; Codex's internal request count is not measured.

Use an explicit scripted choice or explicitly select Claude/Codex. Real mode must resolve the governed isolated-generator facade and enforce the existing room tenant/tier egress policy. Never consume the generic default stub, infer provider availability from registration, silently substitute scripted text, enable untested-version overrides, or create a retention attestation to make a demo run. Client parameters cannot make a confidential room public. The launcher must disclose that provider readiness is unverified and that browser rooms need existing confidential-scope tenant/provider zero-retention and egress authorization; public pasted text does not relax those prerequisites. The current mission-link route only accepts confidential missions, so an existing public mission is not a browser workaround. Frame inline goal/transcript text as untrusted data; this path does not fetch linked URLs or grant model tools.

Before any provider call, acquire the permanent, exclusive, fsynced per-room execution claim and record the attempted operation. Keep the claim if receipts are missing or a process stops: the outcome may be unknown and must not be resent. One live engine owns the room; another process encountering its claim fails closed, which can stop the live owner. A restarted or idle-expired real-provider engine therefore needs a new room, and real-provider decisions cannot be reopened in place. This conservative availability tradeoff is intentional, not an automatic recovery feature. Await transport termination after abort; never race ahead into another invocation. Bound calls by the persisted lifetime budget and 60-second maximum per invocation; no host retry or provider switching.

Persist requested mode/provider separately from successful schema-valid transport evidence. A selection or started attempt is not a successful response; legacy provenance and exact model identity remain unknown. Show failures and recorded provenance in the room and exported bytes. Scripted exports must remain visibly scripted. A generated decision with failed artifact publication is partial failure, not a completed saved result; preserve the decision, record a safe error, and never rerun the model to conceal a storage failure.

Saved brief/minutes reads use the dedicated room-bound endpoint. Authenticate and authorize the room and tier, then match its artifact event to the exact record ID, owner scope, kind and canonical path before touching the file. Read bounded regular non-symlink bytes and verify the stored SHA-256 and byte length. Refresh the same artifact IDs and integrity evidence together after review. Missing legacy evidence, tampering or a partial write fails closed; generated review HTML is a separate view. Keep saved HTML inert and never expand the generic runtime asset allowlist.

Regression gates: discussion-provider-truth, discussion-engine/dialogue/review, discussion-outcomes, discussion-saved-artifact-io, Discussion HTTP execution/artifact routes, discussion-run-contract and DiscussionExecutionStatus tests. Cover unavailable/denied/invalid providers, zero scripted calls, single-call pending progress, failure/timeout/restart cut points, competing claims, bounded replay, exact saved-byte reads, scope/path/tier denials, symlinks, tampering and partial publication. Run the Chronos app TypeScript project explicitly: its Next build skips type validation and the root TypeScript project excludes the app. Keep a production mission-discovery walk regression so missing dependencies cannot be swallowed into an empty mission list. Mocked production-code tests and server-rendered markup do not prove a live model response or rendered-browser end-to-end execution.

## Discussion single-brief prerequisite inspection

Before a browser single-model brief creates a room, inspect the same authenticated local-admin, confidential tier and selected mission/tenant scope used by creation. Readiness must never instantiate a provider session: its constructor reserves the permanent no-replay execution claim. Keep inspection separate from creation, and recheck known blockers on POST before any room, claim or detached engine exists. Execution still performs every authoritative egress and transport gate; a prior inspection is neither a grant nor an execution receipt.

Inspect registered adapter/isolation declarations, the exact current Discussion egress gate and the governed Discussion/artifact destination floors without creating directories or sentinel files. Preserve ordinary governed read auditing. Codex may use its existing bounded which/where locator and permitted regular-file metadata, never a login/version/model command; a configured path alone proves nothing, and denied metadata inspection is unknown rather than absence. Claude's isolated SDK selects its own native executable, so a PATH claude check does not prove that runtime. Never consult credential stores or manufacture retention attestations.

Use fixed public diagnostics with next steps for an existing authorized operator. Expose no credential values, executable paths, policy contents or raw errors. A checked directory or nearest existing parent is not a writability test. Login, transport reachability, tested executable version, runtime-state storage and artifact write success stay explicitly unverified, with zero provider calls. Do not label a configuration-only report ready. A known blocker stops creation; unknown live behavior requires a separate explicit attempt and retains the normal one-call/60-second brief bound.

Bind the browser report to the selected provider and mission. Invalidate it immediately when either changes; ignore aborted, superseded and late responses, deduplicate repeated checks, and do not auto-start when inspection finishes. Keep check failure and blocked prerequisites actionable with a read-only recheck. A failed or lost create response invalidates prior inspection but does not prove that generation never started: retain the original create request handle and use its read-only receipt recovery. The room list and prerequisite GET do not prove the outcome of that request and never authorize resubmission. Scripted mode remains offline.

Regression gates: discussion-readiness, Discussion readiness/execution HTTP routes, readiness controller and panel markup tests, plus Discussion/Presence and package-boundary suites. Cover authorization/tier/tenant/mission denial, missing versus unreadable executables, guarded and missing artifact ancestors, policy failures with zero room creation, malformed reports, stale/overlapping requests and explicit unverified live behavior. These mocked and server-rendered checks do not certify a live provider or a rendered browser journey.

## Discussion uncertain-create request recovery

Before persisting a browser pending marker, resolve the authenticated actor and canonical tenant/organization/project/mission routing through the read-only request-context endpoint. It reserves nothing and never calls a provider. Require an existing selected tenant (or tenant-bound confidential mission); do not invent an unscoped tenant or relabel a public mission. Validate the local input and freeze the submission snapshot across this check. A context failure is pre-submit and must not strand a pending request.

Persist a fresh UUID, original minimal routing and the canonical scope digest before one POST, without goal or transcript text in browser storage. The digest includes absent organization/project/mission fields: reject a mismatch before reservation or recovery lookup, so later mission enrichment cannot silently move an unchanged request into another namespace. This digest is an untrusted selector check, not a signed authorization token. Deduplication is scoped to authenticated principal/source/member, canonical tenant/organization/project/mission/tier and UUID. Same-namespace changed normalized intent conflicts; the same UUID in another canonical scope is a distinct namespace. This is not global cross-tenant or transactional cross-tab exactly-once execution. Retain every outstanding tab handle rather than overwriting another tab's request.

The server exclusively publishes a permanent reservation in the protected confidential tenant receipt store before creating the deterministic room. Store only actor/scope metadata and the normalized intent digest, not another copy of the goal. Only the reservation winner may create the original bound room event and publish the immutable accepted receipt, then return the single launch decision. Duplicates and recovery GETs never launch, repair or create a replacement room, even when the original process stopped before its first provider claim. Readiness blockers can publish a permanent rejection only before room creation; accepted and rejected receipts share one exclusive terminal path and cannot overwrite one another.

The dedicated discussion_request_store role requires an exact deny-only two-file capability for that tenant, actor, scope and UUID. It grants no knowledge access and cannot read room logs or call providers. Recovery has no write or mkdir paths. Reauthorize the original canonical mission and current confidential viewer scope before receipt lookup; validate the immutable room_created event and binding before returning its exact room. A strictly verified original room event can recover that room read-only when its terminal receipt is missing; created means room existence, never proof that provider execution started. Missing room/binding evidence and inaccessible, malformed, torn or conflicting evidence remain unconfirmed. Never use room-list presence or a generic HTTP error as proof of matching intent or nonexecution.

Bound the HTTP wait through body parsing. A timeout or abort ends only the browser wait, not server/provider execution. Preserve unresolved handles across reload, Back and navigation; block replacement generation in every mode. Read-only Check request can reconcile each retained handle independently. A late result must not steal navigation; open a positively matched room only through its explicit read-only action. Clear a pending handle only after exact created evidence or a durable terminal rejection; GET absence remains inconclusive while the first POST may still arrive. Storage failures before POST must fail closed.

Reservations and receipts are review_required state with no TTL or automatic status deletion. Never reclaim a reservation on elapsed time, process death or missing room evidence. File fsync and exclusive publication support process-concurrency/restart safety; they are not a claim of complete power-loss durability. Losing exclusive publishers can briefly change a receipt directory while the winner verifies its file: retry only the exact ancestor-instability snapshot error, at most eight complete governed reads with the original leaf identity/content metadata pinned. Never retry a write, a policy denial, a changed leaf or a malformed record. A crash cut point or exhausted read instability can intentionally sacrifice availability rather than duplicate a charged call. Removing these tombstones requires a separate human retention decision that preserves the no-replay boundary.

Regression gates: discussion-create-request, discussion-request-storage-boundary, create/recovery/context HTTP routes and discussion-create-recovery client/UI tests. Cover real competing OS processes and fresh-process recovery with mocked providers, exactly one creator in a clean race and at most one under injected faults, same-scope changed intent, actor/source/scope isolation, missing/corrupt evidence, rejected receipt finality, late POST/body responses, reload/scope changes, per-handle recovery and browser storage failure. Verify exact-capability positive access plus ambient-role, sibling actor/scope/request, tenant, knowledge, room, symlink/hard-link, missing/corrupt policy and GET mutation denials. Production-code fixtures and client harnesses do not prove live provider execution or a rendered browser journey.

## Company-story intent, readiness, and learning continuity

A request to produce a document for a new project must remain a document project
through intent resolution, organization intake, execution-brief requirements and
project task bootstrap. Test that chain with natural paraphrases and negative
controls for recurring meetings and calendar reads; a correct first classifier
alone is insufficient.

Mission status must distinguish recorded task closure and structural evidence
from successful model execution. Cached provider health is an observation, not
current readiness. Evaluate provider egress against the mission's exact tenant
and tier, preserve unknown when observations are unavailable, and never let an
allowed but missing local provider hide an installed external provider's refusal.

Feedback proposals are not approved knowledge. Keep queue admission, human review,
actual promotion, and retrieval/use evidence separate. Any link to an existing
memory candidate must bind canonical scope and content digest; legacy unscoped,
cross-tenant, stale, or missing records must not become success by inference.
Read-only inspection must not invoke providers, approve, promote, or fabricate a
promoted reference.

Regression gate: run the intent-resolution, organization-operating-model,
execution-brief, project-registry, mission-execution-readiness, mission-controller,
and execution-feedback suites. Include tenant mismatch, expired permission,
legacy feedback, stale links and missing artifacts. Validate synthetic execution
separately from a real provider run and record any runtime blocker honestly.

The current feedback handoff supports only explicit tenant-wide confidential
proposals. Organization, project, mission, owner/audience and other narrower
scope shapes remain review-only until the promotion foundation preserves them.
Legacy proposals require explicit read-only inspection and cannot be adopted
through a scoped lookup. Promotion references remain unverified and retrieval
remains unmeasured until exact attributable evidence is available; neither
aggregate counts nor candidate labels are proof. Tenant-scoped natural-language
surface feedback and subsequent scenario hint reuse remain separate integration
gaps, not completion claims of this CLI handoff.
