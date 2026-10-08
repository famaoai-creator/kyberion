# GitHub Actions Workflows

## Current Contracts

The repository currently maintains four execution workflows and one maintenance workflow.

1. `ci.yml`
   Runs on pushes, pull requests to `main`, and the weekly schedule.

2. `pr-validation.yml`
   Runs on pull requests targeting `main` or `develop`.

3. `cross-os.yml`
   Runs the supported-OS smoke matrix on pushes, pull requests to `main`, and the weekly schedule.

4. `release.yml`
   Builds and publishes tagged releases.

5. `stale.yml`
   Performs issue and pull-request housekeeping on its own schedule or manual dispatch.

The four execution workflows use `.github/actions/setup-kyberion/action.yml` after checkout. The
action owns the pinned pnpm version, Node setup, and frozen dependency install; workflow-specific
native packages and test/build steps remain in each workflow.

The execution workflows are expected to separate **package/app build** from **operational validation**.

- `pnpm build` must build package-local workspace artifacts first, then repo-level `dist/`
- operational validation still runs against built scripts under `dist/`

They must not depend on removed `skills` scripts or on stale package-local build artifacts.

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
(4 shards), the actuator suite, governance boundary tests, lint, typecheck and format. On
`pull_request` events `ci.yml` skips its `core`/`actuators` matrix entries and its lint/format/
typecheck steps, and `cross-os.yml` skips the Linux core shards and boundary tests; all of them
still run on `main` pushes and on the weekly schedule. Before adding a test step to a workflow,
check which workflow already owns that suite for pull requests.

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
