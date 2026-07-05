# Troubleshooting

Use this guide when Kyberion looks installed but does not feel usable yet.

## 1. First check

Run the compact readiness view first:

```bash
pnpm setup:report --persona first-time-user
```

If you want the lower-level gate instead, run:

```bash
pnpm doctor
```

## 2. Surface problems

If a surface is stale, unhealthy, or stuck with an old pid, inspect and repair it:

```bash
pnpm surfaces:status
pnpm surfaces:repair -- --surface <surface-id>
```

If you need to rebuild surface state from the manifest, use:

```bash
pnpm surfaces:reconcile
```

Useful logs:

- `active/shared/logs/surfaces/`
- `active/shared/runtime/surfaces/state.json`

## 3. First-win browser issues

If `pnpm pipeline --input pipelines/verify-session.json` fails with browser permission or launch errors:

1. Re-run `pnpm setup:report --persona first-time-user`.
2. Run `pnpm doctor --runtime browser` to check the browser/Playwright preflight.
3. Confirm the browser surface is healthy with `pnpm surfaces:status`.
4. Repair the tracked surface if it is stale: `pnpm surfaces:repair -- --surface <surface-id>`.
5. Retry the first-win smoke.

The smoke writes `active/shared/tmp/first-win-session.png` when it succeeds.

## 4. Missing auth or connections

If `pnpm setup:report` shows auth or connection gaps:

- Run `pnpm surfaces:setup` to inspect surface readiness.
- Run `pnpm services:setup` to inspect service auth and connection files.
- Fix the missing secret, preset, or connection file, then re-run `pnpm setup:report`.
- Chronos control-plane routes still rely on `KYBERION_API_TOKEN` or `KYBERION_LOCALADMIN_TOKEN` locally; moving those routes to IdP-backed user sessions is still a follow-up task.

## 5. When to ask for more context

If the problem is not covered here, capture:

1. The command you ran.
2. The exact error text.
3. The output of `pnpm surfaces:status`.
4. The output of `pnpm setup:report --persona first-time-user`.

That is usually enough to narrow the issue quickly.
