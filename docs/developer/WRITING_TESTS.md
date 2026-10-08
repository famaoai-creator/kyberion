# Writing tests in Kyberion

How to write a test that passes in a fresh clone, on any OS, and never touches the operator's real runtime state. The binding rules live in [kyberion-development-practices §3](../../knowledge/product/governance/kyberion-development-practices.md#3-hermetic-tests--the-machine-is-not-a-fixture). This page shows how to follow them.

## Running tests

```bash
pnpm vitest run libs/core/path/to/thing.test.ts   # one file (fastest loop)
pnpm test -- --suite core                          # a named CI suite: smoke | unit | core | actuators | scripts | integration
pnpm vitest run                                    # everything (slow; see "After a full run")
```

- Tests run in forked workers (`pool: 'forks'`, 4 at a time). Each worker has its own `process.env`, but every worker shares the same checkout on disk.
- The default timeout is 10s locally and 30s on CI. If a test needs more locally, the test is doing too much real work: mock the slow edge rather than raising the timeout.
- **Child processes run compiled code.** A test that spawns `node … @agent/core/...` loads `dist/`, not your edited source. Run `pnpm run build:packages` after changing `libs/core` before you trust such a test locally. CI builds `dist/` first.

## Where a test may write

`active/` is the operator's **live** runtime tree: missions, delivery outboxes, the audit log and ledger, ops alerts, the inbox, task sessions, work coordination and so on. A test that writes there mixes fixtures into real state. A fixture message in a Telegram outbox can be sent by a running delivery daemon. A fixture event in the audit log becomes "evidence".

Pick the first option that fits:

| You need…                                        | Use                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| A scratch file or directory                      | `pathResolver.sharedTmp('<suite>-<pid>/…')`, removed in `afterEach`/`afterAll`             |
| To exercise a store (outbox, audit, sessions, …) | The store's own API, or `pathResolver.shared('…')` for the path — the sandbox handles it   |
| A whole isolated repository root                 | A fixture root: temp dir + `KYBERION_ROOT`, then `vi.resetModules()` and import the module |
| A fixture mission                                | A fixture root, or clean up the mission directory in `afterAll` (see below)                |

### The Vitest sandbox (`vitest-live`)

Under Vitest, `path-resolver` maps the live operational subtrees into `active/shared/runtime/vitest-live/pool-<n>/`. The full list is `VITEST_LIVE_SUBTREES` in [`libs/core/path-resolver.ts`](../../libs/core/path-resolver.ts). The mapping applies to `pathResolver.shared()`, `resolve()` and `rootResolve()`, and therefore to every `secure-io` call, for reads and writes alike. Code under test still round-trips through the same API, so most tests need nothing special.

Three rules keep you on the sandbox:

1. **Build paths with `pathResolver`, never `path.join(root, 'active/…')`.** A hand-built path skips the remap. Production code that takes an injectable `rootDir` should wrap the result in `pathResolver.vitestLivePath(...)`, as `task-session.ts` and `work-coordination.ts` do. A fixture `rootDir` passes through unchanged.
2. **Assert the store's sub-path, not the `active/` prefix.**

   ```ts
   // ✗ breaks under the sandbox, and pins an implementation detail
   expect(path).toContain('/active/shared/coordination/channels/slack/outbox/');
   // ✓
   expect(path).toContain('/coordination/channels/slack/outbox/');
   ```

3. **Do not read or seed live paths with raw `fs`.** `fs.existsSync(path.join(cwd, 'active/…'))` looks at the live tree while the code wrote to the sandbox. Use the same `pathResolver` path the code uses:

   ```ts
   // ✗ checks (and its rmSync cleanup deletes) the operator's real directory
   const DIR = path.resolve(process.cwd(), 'active/shared/runtime/feedback-loop/hints');
   // ✓ the sandboxed directory under Vitest
   const DIR = pathResolver.shared('runtime/feedback-loop/hints');
   ```

The sandbox is skipped when the project root is not the checkout that contains the code (a fixture `KYBERION_ROOT`). Fixture roots are already isolated, and a parent test and the child it spawns always agree.

### Fixture roots

Use a fixture root when the code under test reads repository data you want to control: schemas, governance JSON, a tenant registry.

```ts
beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), `kyberion-thing-${randomUUID()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}'); // marks it as a project root
  // copy only the knowledge/ files the module needs
  process.env.KYBERION_ROOT = tmpRoot;
  vi.resetModules(); // path-resolver reads KYBERION_ROOT at import time
});
afterEach(() => {
  delete process.env.KYBERION_ROOT;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
```

`libs/core/deliverable-inbox.test.ts` and `scripts/virtual_office.test.ts` are working examples.

### Fixture missions in the live tree

If a test must create a mission under the real `active/missions/`, remove it, and restore any env it set:

```ts
it('records task details', async (ctx) => {
  const previousRole = process.env.MISSION_ROLE;
  process.env.MISSION_ROLE = 'mission_controller';
  const missionPath = pathResolver.missionDir('MSN-MY-FIXTURE', 'public');
  ctx.onTestFinished(() => {
    safeRmSync(missionPath, { recursive: true, force: true });
    if (previousRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = previousRole;
  });
  // …
});
```

Leftover fixture missions show up in `pnpm mission list` and in mission hygiene for every operator who ran the tests.

## Other gates that exist for tests

- **Approvals** go to `active/shared/runtime/vitest-approvals/` (`approvalStoreRoots()`).
- **Operator notifications** are suppressed under Vitest. A delivery suite opts back in with `KYBERION_ALLOW_TEST_NOTIFICATIONS=1`.
- **Traces** are not persisted under Vitest unless the caller passes a `dir` or sets `KYBERION_TRACE_TEST_PERSIST=1`.
- **Child processes** inherit `VITEST` / `VITEST_POOL_ID` (`SAFE_EXEC_ENV_ALLOWLIST`, `CHILD_PROCESS_ENV_KEYS`), so a script spawned by a test uses the same sandbox.
- **Network egress** to anything but localhost is rejected by `tests/vitest-network-guard.ts` (explicit `host:port` exceptions go in `KYBERION_VITEST_NETWORK_ALLOWLIST`); mock remote clients instead.
- **Locks** (`active/shared/runtime/locks`) are not sandboxed: many suites partially mock `path-resolver`, and lock files are short-lived. A test that holds a lock on purpose (a timeout scenario) must `releaseLock` it in `afterAll`.

## Things a test may not depend on

These are covered in detail in development practices §3:

- **An onboarded profile:** seed `my-identity.json`, `my-vision.md` and `agent-identity.json` under a fixture knowledge root.
- **Installed provider CLIs:** seed `active/shared/runtime/provider-cache.json`, and don't call `refreshProviderDiscoveryCache()` afterwards.
- **Leftovers from earlier runs or `/tmp`:** create what the flow validates.
- **The calendar:** use `vi.useFakeTimers({ now, toFake: ['Date'] })` for the whole flow.
- **Host binaries** (`sqlite3`, LibreOffice, CJK fonts): a test that needs one must skip or mock when it is absent. Otherwise it fails on minimal machines and CI images. Gate on the probe of the module that owns the dependency, so the test skips exactly when the code would fail: `it.skipIf(!probeHistorySearchBackend().available)` (sqlite3 with FTS5 trigram), `it.skipIf(!pickCjkFontSource())` (CJK font), `describe.skipIf(!detectRasterCapabilities().hasPdfRaster)` (poppler). CI installs these, so the tests still run there.

Smell test: _would this pass in a fresh clone, on a different OS, on the first run?_

## Registration ceremonies

Some gates fail when a test adds something new:

- A new **direct `node:fs` import** (test setup files, guards): add the file to `tests/fixtures/governance-import-baseline.json` in the same change.
- A new **`KYBERION_*` variable** read by non-test code: run `pnpm generate:env-registry` and fill in its description. Files under `tests/` are not scanned.

## After a full run

`tests/vitest-active-leak-guard.ts` (a Vitest `globalSetup`) snapshots `active/` before the run. Afterwards it lists every file the run created or grew outside `active/shared/tmp`, `active/shared/cache` and `vitest-*` roots:

```text
[vitest-active-leak-guard] tests wrote 3 file(s) into live active/ state … | evidence: active/shared/tmp/vitest-active-leaks.json
```

Open `active/shared/tmp/vitest-active-leaks.json` to see the files. Fix a leak in one of these ways:

- route the writer through `pathResolver` or `vitestLivePath`;
- add the store's subtree to `VITEST_LIVE_SUBTREES`;
- move the test to a fixture root.

Set `KYBERION_TEST_LEAK_STRICT=1` to make the run fail on any leak. CI sets it for every workflow that runs Vitest, and `pnpm test -- --suite …` forwards it to the Vitest child. Also check `git status`: tracked files must never change during a test run.
