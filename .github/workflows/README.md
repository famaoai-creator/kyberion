# GitHub Actions Workflows

## Current Contracts

The repository currently maintains two GitHub Actions workflows.

1. `ci.yml`
   Runs on pushes, pull requests to `main`, and the weekly schedule.

2. `pr-validation.yml`
   Runs on pull requests targeting `main` or `develop`.

Both workflows are expected to separate **package/app build** from **operational validation**.

- `pnpm build` must build package-local workspace artifacts first, then repo-level `dist/`
- operational validation still runs against built scripts under `dist/`

They must not depend on removed `skills` scripts or on stale package-local build artifacts.

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
9. build size audit via `node dist/scripts/measure-build-size.js --json --no-save`

## PR Validation Workflow

`pr-validation.yml` performs:

1. build
2. typecheck
3. lint
4. test coverage
5. coverage threshold validation
6. coverage reporting
7. security scan
8. build size measurement using `node dist/scripts/measure-build-size.js`

## Coverage Threshold

The pull request workflow reads `COVERAGE_THRESHOLD` from GitHub Actions repository variables.

- Default: `60`
- Location: `Settings -> Secrets and variables -> Actions -> Variables`

If `coverage/coverage-summary.json` is missing, the workflow fails by design.

## Operational Note: Background Terminal Warnings

Local warnings such as `Waited for background terminal` should not be conflated with GitHub Actions failures.

- GitHub Actions runs clean ephemeral runners and does not reuse Codex unified exec sessions.
- Local development can still accumulate residual CLI processes from `tsx`, `mission_controller`, or one-shot diagnostics if the terminal host retains exec sessions.
- Kyberion-managed long-lived runtimes must be inspected through `pnpm surfaces:status`, not by inferring from editor terminal warnings alone.

When investigating local residue:

1. Check surface lifecycle status with `pnpm surfaces:status`
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
- Confirm `node dist/scripts/measure-build-size.js --json --no-save` succeeds locally

### Surface validation failed

- Confirm `knowledge/public/governance/active-surfaces.json` is valid
- Confirm `node dist/scripts/surface_runtime.js --action status` succeeds locally
