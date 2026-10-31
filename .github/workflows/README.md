# GitHub Actions Workflows

## Current Contracts

The repository currently maintains four execution workflows and two maintenance workflows.

1. `ci.yml`
   Runs on pushes, pull requests to `main`, merge-queue (`merge_group`) entries, and the weekly
   schedule.

2. `pr-validation.yml`
   Runs on pull requests targeting `main` or `develop`, and on merge-queue (`merge_group`) entries.

3. `cross-os.yml`
   Runs the supported-OS smoke matrix on pushes, pull requests to `main`, merge-queue entries, and
   the weekly schedule (prose-only PRs skip the OS jobs; see "Cross-OS shape").

4. `release.yml`
   Builds and publishes tagged releases.

5. `stale.yml`
   Performs issue and pull-request housekeeping on its own schedule or manual dispatch.

6. `main-failure-triage.yml`
   Runs after a failed `CI` or `Cross-OS Smoke` run on `main` (`workflow_run`). It downloads the
   failed jobs' logs, classifies them with `scripts/ci_failure_triage.ts`, and opens or comments on
   one `ci-main-red` issue per failing signature. Permissions: `actions: read`, `contents: read`,
   `issues: write`.

The four execution workflows use `.github/actions/setup-kyberion/action.yml` after checkout. The
action owns the pinned pnpm version, Node setup, and frozen dependency install; workflow-specific
native packages and test/build steps remain in each workflow.

The execution workflows are expected to separate **package/app build** from **operational validation**.

- `pnpm build` must build package-local workspace artifacts first, then repo-level `dist/`
- operational validation still runs against built scripts under `dist/`

They must not depend on removed `skills` scripts or on stale package-local build artifacts.

## Failure triage

Each main job in `ci.yml`, `pr-validation.yml` and `cross-os.yml` tees its test and check output
into `$RUNNER_TEMP/kyberion-ci-output.log`. The job then ends with a `Triage failure` step
(`if: failure()`, `.github/actions/ci-failure-triage`). That step writes each failure's class and
next command to the job summary. Who acts on which class: operations-hygiene runbook §1
"CI failure triage". The `cross-os.yml` `windows-native` job keeps its default PowerShell steps and
has no triage step yet; read its failed step log directly.

## Workflow contract (enforced)

The `ci-workflow-contract` gate (`scripts/check_ci_workflow_contract.ts`, scope `pr`) fails when:

- a job has no `timeout-minutes` (the 360-minute default can hold a runner for six hours);
- a `pull_request` workflow has no top-level `concurrency` with `cancel-in-progress`
  (use the `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` group
  and cancel only for `pull_request` events, so `main` and scheduled runs are never cancelled);
- an action is pinned below its first Node 24 major (see `MIN_ACTION_MAJORS`);
- a job runs `pnpm --filter '@agent/core' build` before `pnpm run build` (the full build already
  builds every workspace package).

**One owner per suite on pull requests.** `pr-validation.yml` owns the PR run of the core suite
(6 shards), the actuator suite, the pr-scope gates (`pnpm run check -- --scope pr`, including the
governance boundary tests in the `registration-tests` gate), lint, typecheck and format. On
`pull_request` events `ci.yml` skips its `core`/`actuators` matrix entries and its lint/format/
typecheck steps, and `cross-os.yml` skips the Linux core shards and boundary tests; all of them
still run on `main` pushes and on the weekly schedule. Before adding a test step to a workflow,
check which workflow already owns that suite for pull requests.

**Check scopes per event.** Gates in `knowledge/product/governance/ci-gates.json` declare `pr`,
`full` or `release`; `--scope` selects:

| `--scope`   | Selects                | Run by                                                        |
| ----------- | ---------------------- | ------------------------------------------------------------- |
| `pr`        | pr gates               | `pr-validation.yml` pr-gates (pull_request, merge_group)      |
| `full-only` | full gates, no pr gate | `ci.yml` lint-and-validate on pull_request and merge_group    |
| `full`      | pr + full gates        | `ci.yml` lint-and-validate on push to `main` and the schedule |
| `release`   | every gate             | `release.yml`                                                 |

`pr` + `full-only` = `full`, so a PR runs each gate exactly once. `ci-gate-parity` enforces the
`CHECK_SCOPE` selector in `ci.yml`. Likewise `ci.yml`'s `integration` shards pass
`--skip-gate-tests`, which excludes the test files a pr-scope gate already runs through vitest
(`registration-tests`); a local `pnpm test -- --suite integration` still runs all of `tests/`.

**Suite sharding.** `ci.yml` shards `scripts` (3-ways) and `integration` (2-ways) through vitest
`--shard=N/M` passed as `pnpm test -- --suite <s> --shard=N/M` — the dispatcher forwards Vitest
options unchanged. `pr-validation.yml` shards the core suite 6-ways the same way. Sharded matrix
entries carry a `shard` key so job names stay distinct (`test (scripts, 1/3)`).

**Vitest transform cache.** `vitest.config.mts` sets `fsModuleCache: true`
(`node_modules/.vitest-cache`, content-hashed). `setup-kyberion` restores that directory from
`actions/cache`, so CI test jobs reuse prior-run transforms instead of re-transforming every
source (transform was ~20-30% of suite wall time).

**Shared build artifact.** Both `ci.yml` and `pr-validation.yml` run one `build-artifacts`
job that uploads the owned compiler outputs (`dist/`, `libs/*/dist`, package dists, knowledge
manifest — the same set declared in `scripts/build-output-layout.ts`, minus the multi-GB
`.next` UI bundles). Downstream jobs declare `needs: build-artifacts` and restore with
`actions/download-artifact` instead of re-running `pnpm run build` (~4min per job).
`first-win-clean-clone` keeps its own build — a clean checkout build IS the check there.
Jobs that need `.next` must build it locally with `pnpm run build:ui`.

**No skip cascade (one failure, every signal).** In `ci.yml`, `test`, `intent-smoke` and
`first-win-clean-clone` do not depend on `lint-and-validate` (only on `build-artifacts`, or on
nothing for the clean-clone build), so a red lint/gate step no longer skips the test matrix and
forces a second CI round. Inside `lint-and-validate` (and `pr-validation.yml` `static-checks` /
`test-extra`) the independent check steps run with
`if: ${{ !cancelled() && steps.workspace.outcome == 'success' }}`: they need only the prepared
workspace (the `workspace` download step), still run after an earlier check failed, and the job
still fails if any step failed.

**Cross-OS shape.** `cross-os.yml` runs `changes` → `build-artifacts` (one Linux build, artifact
`cross-os-build-outputs`) → `build-and-smoke` (ubuntu/macOS × 3 shards, downloading that
artifact — compiler outputs are plain JS, native addons come from each OS's own `pnpm install`)
and `windows-native` (keeps its own `pnpm run build`, because `scripts/build_repository.ts` has a
Windows-specific spawn path). Typecheck is not repeated per OS. `changes` diffs the PR merge
commit against its first parent (or the merge-group base) and skips the OS jobs when only prose
changed (`.md`/`.mdx`/`.txt` under `docs/`, `knowledge/`, `changelog.d/`, `.github/`, or root
`*.md`). Pushes to `main`, the weekly cron and any diff error run everything. Never add a
workflow-level `paths:` filter — it leaves required checks pending. Skipped matrices do not
report their per-OS check names, so the always-running `cross-os-result` job is the single
check to require; it fails when any OS job failed, was cancelled, or was skipped without a
prose-only diff.

**Merge-queue readiness.** `ci.yml`, `pr-validation.yml` and `cross-os.yml` also trigger on
`merge_group`. There, PR-owned duplicates are skipped exactly as on `pull_request`
(`github.event_name == 'pull_request' || github.event_name == 'merge_group'`), PR-only steps
(title check, vital-check comment) are skipped, and the run is never cancelled
(`cancel-in-progress` stays `pull_request`-only; each queue entry has its own
`gh-readonly-queue/...` ref). Enabling the queue and choosing required checks are repository
settings the owner changes manually: require `pr-gates`, `static-checks`, the `core-tests`
shards, `actuator/boundary/security tests`, the `ci.yml` `lint-and-validate` / `test` /
`intent-smoke` / `first-win-clean-clone` checks, and `cross-os-result` (which covers the
macOS and Windows jobs, so a red Windows job blocks the merge).

**Vital-check comment.** `pr-validation.yml` `vital-check` keeps one PR comment, found by the
hidden marker `<!-- kyberion:vital-check-report -->`: created on the first run, edited when the
report changes, and left alone when it is unchanged.

## CI Workflow

`ci.yml` performs:

1. `pnpm install --frozen-lockfile`
2. `pnpm build`
3. `pnpm lint`
4. `pnpm typecheck`
5. capability discovery validation via `node dist/scripts/capability_discovery.js`
6. runtime surface manifest/status validation via `node dist/scripts/surface_runtime.js --action status`
7. smoke/unit/integration tests
8. security audit
9. vital check audit via `node dist/scripts/vital_check.js --format json --exit-on-missing=false`

## PR Validation Workflow

`pr-validation.yml` performs:

1. build
2. typecheck
3. lint
4. test coverage
5. coverage threshold validation
6. coverage reporting
7. security scan
8. vital check measurement using `node dist/scripts/vital_check.js --format text`

## Coverage Threshold

The pull request workflow reads `COVERAGE_THRESHOLD` from GitHub Actions repository variables.

- Default: `60`
- Location: `Settings -> Secrets and variables -> Actions -> Variables`

If `coverage/coverage-summary.json` is missing, the workflow fails by design.

## Operational Note: Background Terminal Warnings

Local warnings such as `Waited for background terminal` should not be conflated with GitHub Actions failures.

- GitHub Actions runs clean ephemeral runners and does not reuse Codex unified exec sessions.
- Local development can still accumulate residual CLI processes from `tsx`, `mission_controller`, or one-shot diagnostics if the terminal host retains exec sessions.
- Kyberion-managed long-lived runtimes must be inspected through `pnpm surfaces status`, not by inferring from editor terminal warnings alone.

When investigating local residue:

1. Check surface lifecycle status with `pnpm surfaces status`
2. Compare with local process listings such as `ps -axo pid,ppid,etime,command`
3. Distinguish Kyberion-managed surfaces from external terminal host session retention

## Required Permissions

`pr-validation.yml` requires:

- `contents: read`
- `pull-requests: write`

## Troubleshooting

### Coverage comment is missing

- Confirm the workflow still has `pull-requests: write`
- Confirm `coverage/coverage-summary.json` was produced

### Build size report failed

- Confirm `pnpm build` produced `dist/`
- Confirm `node dist/scripts/vital_check.js --format json --exit-on-missing=false` succeeds locally

### Surface validation failed

- Confirm `knowledge/product/governance/active-surfaces.json` is valid
- Confirm `node dist/scripts/surface_runtime.js --action status` succeeds locally
