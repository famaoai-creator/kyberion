# Troubleshooting

Use this guide when Kyberion looks installed but does not feel usable yet.

## 1. First check

Run the compact readiness view first:

```bash
pnpm kyberion setup report --persona first-time-user
```

If you want the lower-level gate instead, run:

```bash
pnpm kyberion doctor
```

## 2. Surface problems

If a surface is stale, unhealthy, or stuck with an old pid, inspect and repair it:

```bash
pnpm surfaces status
pnpm surfaces repair -- --surface <surface-id>
```

If you need to rebuild surface state from the manifest, use:

```bash
pnpm surfaces reconcile
```

Useful logs:

- `active/shared/logs/surfaces/`
- `active/shared/runtime/surfaces/state.json`

## 3. First-win browser issues

If `pnpm pipeline --input pipelines/verify-session.json` fails with browser permission or launch errors:

1. Re-run `pnpm kyberion setup report --persona first-time-user`.
2. Run `pnpm kyberion doctor --runtime browser` to check the browser/Playwright preflight.
3. Confirm the browser surface is healthy with `pnpm surfaces status`.
4. Repair the tracked surface if it is stale: `pnpm surfaces repair -- --surface <surface-id>`.
5. Retry the first-win smoke.

The smoke writes `active/shared/tmp/first-win-session.png` when it succeeds.

## 4. Missing auth or connections

If `pnpm kyberion setup report` shows auth or connection gaps:

- Run `pnpm surfaces setup` to inspect surface readiness.
- Run `pnpm service:setup` to inspect service auth and connection files.
- Fix the missing secret, preset, or connection file, then re-run `pnpm kyberion setup report`.
- Chronos control-plane routes still rely on `KYBERION_API_TOKEN` or `KYBERION_LOCALADMIN_TOKEN` locally; moving those routes to IdP-backed user sessions is still a follow-up task.

## 5. "Run `pnpm build` first"

Many commands run compiled code from `dist/`. On a fresh clone, after a `git pull` that changed TypeScript, or after deleting `dist/`, they print a hint to run `pnpm build` instead of a raw module-not-found error. Run:

```bash
pnpm build
```

and repeat the command. `pnpm capabilities` and a few discovery commands work from source without a build, but anything that executes a pipeline needs it.

## 6. A warning about an unknown `KYBERION_*` variable

Kyberion checks the environment against its variable registry. Outside CI an unrecognised `KYBERION_*` variable is only a warning, printed once with a "did you mean" suggestion: it is usually a typo or a variable left over from an older version. Fix the name in your shell or `.env.local`, or remove it. A known variable with an invalid value still stops the command. In CI, or with `KYBERION_ENV_REGISTRY_STRICT=1`, unknown variables are errors. The registry itself is `knowledge/product/governance/env-registry.json`.

## 7. Capture pads say a tenant scope is needed

`pnpm pads` starts the local capture pads. Pads that store confidential or personal material need to know which tenant they belong to, so they refuse to start without one and tell you how to proceed:

- set `KYBERION_TENANT=<tenant-slug>` (list the registered tenants with `pnpm tenant list`), or
- run only the public pads with `pnpm pads --tier public`.

## 8. Bare `pnpm doctor` is not Kyberion's doctor

Use **`pnpm kyberion doctor`** (or `pnpm run doctor`). A bare `pnpm doctor` is pnpm's own built-in diagnostic about its registry and cache; it never runs Kyberion's readiness checks, so a green result there says nothing about Kyberion. For one area at a time use `pnpm kyberion doctor --scope env|service|voice|meeting|app|setup`.

## 9. `--help` and unknown commands

Every `kyberion` command answers `--help` (or `-h`) with its usage and exits without doing anything, including destructive ones such as `pr create` or `secrets encrypt`. If you are unsure what a command does, add `--help` first. `pnpm kyberion --help` shows the grouped command list (add `--all` for developer commands); the same list with every command is the [CLI Reference](../CLI_REFERENCE.md). A mistyped command prints a "did you mean" suggestion. A command that was renamed still works and prints a one-line deprecation notice naming its replacement.

## 10. A command seems stuck

Servers, daemons, the TUI, the build, and test and check runs are long-running by design: `pnpm pads`, `pnpm tui`, `pnpm scheduler`, `pnpm agent-runtime:supervisor`, `pnpm build`, `pnpm check`. They stream their output and have no time limit, so a quiet terminal usually means they are working or waiting for you. Stop one with Ctrl+C. Interactive commands such as `pnpm onboarding` need a real terminal; without a TTY they stop immediately (see [INITIALIZATION](../INITIALIZATION.md), Stage 7, for the non-interactive path). If a command that should finish quickly hangs, rerun it with `--verbose` or `--help` and capture the output as described below.

## 11. When to ask for more context

If the problem is not covered here, capture:

1. The command you ran.
2. The exact error text.
3. The output of `pnpm surfaces status`.
4. The output of `pnpm kyberion setup report --persona first-time-user`.

That is usually enough to narrow the issue quickly.
