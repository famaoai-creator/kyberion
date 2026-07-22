# Kyberion Development Practices — Hard-Won Rules for Changing This Repo

**Purpose**: the repo-specific disciplines that changing Kyberion itself
requires — learned the expensive way across the 2026-06/07 hardening
sessions. The general operating philosophy lives in
[working-philosophy](./working-philosophy.md); this document is about THIS
codebase's registration ceremonies, platform traps, and verification order.

**Audience**: anyone (human or agent) writing code in this repository.

---

## 1. Registration ceremonies — additions are not done until registered

This repo guards its boundaries with contract tests. Adding code without the
matching registration compiles fine locally and then fails CI (or worse,
weakens a boundary silently). Ceremony checklist by change type:

| You added…                                                  | You must also…                                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a new `libs/core/*.ts` module used via `@agent/core`        | export it from `libs/core/index.ts` (typecheck does NOT catch a missing barrel export — `build:actuators` resolves dist and fails on CI only)                                                               |
| a test file that imports `node:fs` directly                 | register it in `tests/fixtures/governance-import-baseline.json` AND `tests/core-fs-exception-boundary.test.ts` `allowedCoreFsImports`                                                                       |
| a `spawnManagedProcess` caller                              | add it to `tests/process-boundary-governance.test.ts` `allowedManagedProcessConsumers`                                                                                                                      |
| a direct `child_process` import                             | add it to `tests/runtime-child-process-boundary.test.ts` (prefer `spawnManagedProcess` instead)                                                                                                             |
| a white-box test import (`../libs/core/x.js` from `tests/`) | add the specifier to `tests/package-boundary-contract.test.ts`                                                                                                                                              |
| a workspace-source import from `scripts/`                   | justify it in `scripts/check_esm_integrity.ts` `ALLOWED_WORKSPACE_SOURCE_IMPORT_FILES` (only bootstrap-class scripts qualify — see `scripts/clean.ts`)                                                      |
| a script that writes governed paths (`knowledge/**`)        | grant its script-name-derived authority role a **narrowly scoped** `allow_write` in `knowledge/product/governance/security-policy.json` (pattern: `generate_design_tokens`)                                 |
| **any of the above**                                        | finish the ceremony by RUNNING the matching contract suite (`pnpm vitest run tests/package-boundary-contract.test.ts` etc.) — editing the code without running the gate is how the same failure ships twice |
| a knowledge document                                        | `pnpm generate:knowledge-index` (lint-staged does this when knowledge files are staged)                                                                                                                     |

### 1.1 Adapter-first extension rule

When multiple implementations provide one capability, use the adapter-first
boundary defined in [Adapter-First Extension Policy](./adapter-first-extension-policy.md).
The capability contract and resolver are the caller-facing API; provider and
engine IDs belong in registry data. A provider that uses an existing adapter
must be added through registration, schema, readiness, security, and focused
tests without adding provider-specific branches to callers or UI.

If the provider introduces a genuinely new protocol, add one adapter and its
versioned contract tests. Do not spread that protocol's branches through
surfaces, orchestration, or fallback code. Unknown or incomplete adapters must
fail closed as unsupported, with an operator-visible reason.

## 2. Cross-platform determinism — the Linux CI rules

Every one of these took a red CI round to learn (PR #475):

- **Never `localeCompare` in generators.** ICU collation differs between
  macOS and Linux; generated files (indexes, catalogs) become
  non-reproducible. Sort by codepoint.
- **Unix socket paths cap at ~104/108 chars.** CI checkout prefixes
  (`/home/runner/work/...`) blow the budget. Sockets go in `os.tmpdir()`
  with short names — this is the one sanctioned exception to the
  `active/shared/tmp/` temp rule.
- **Linux runners have no CJK fonts.** Anything exercising CJK rendering
  needs `fonts-noto-cjk` in the workflow (already in ci.yml,
  pr-validation.yml, cross-os.yml — keep new workflows consistent).
- **Golden snapshots**: `baseline-check` is rebaselineable
  (`MISSION_ROLE=mission_controller KYBERION_SUDO=true node
dist/scripts/check_golden_output.js --rebaseline`); `vital-check` is
  cross-platform — never rebaseline it from a Mac, macOS-flavored output
  breaks Linux.
- **Heavy suites need explicit timeouts.** Shared runners are ~3-8× slower
  than a dev Mac; anything over ~3s locally gets `{ timeout: 60_000 }`.
- **Platform-specific behavior is declared, not discovered**:
  `it.skipIf(process.platform !== 'darwin')` for say/mlx/BlackHole-class
  tests, with a comment saying why.

## 3. Hermetic tests — the machine is not a fixture

13 tests were green for weeks only because this dev box had the right
leftovers. A test may not depend on:

- **an onboarded profile** — seed `my-identity.json`, `my-vision.md`,
  `agent-identity.json` under the test knowledge root (the mission
  controller gates on all three);
- **installed provider CLIs** — seed the discovery disk cache
  (`active/shared/runtime/provider-cache.json`) and do NOT call
  `refreshProviderDiscoveryCache()` afterwards (it force-reprobes the real
  environment and overwrites the fixture);
- **artifact history in `active/`** — seed via
  `appendArtifactOwnershipRecord` / the relevant store API;
- **`/tmp` leftovers** — if a flow validates a file it claims to produce,
  the test must create it (or mock the validation), never assume a prior
  run left one;
- **the real operator inbox/channels** — notifyOperator is hard-gated
  under vitest (`KYBERION_ALLOW_TEST_NOTIFICATIONS=1` opts a delivery
  suite back in); 82 phantom inbox entries from un-mocked finishMission
  flows taught us this;
- **the calendar** — absolute dates in fixtures rot; freeze
  `vi.useFakeTimers({ now, toFake: ['Date'] })` for the WHOLE flow, not
  just the assertion phase.

Smell test: _would this pass in a fresh clone on a different OS on the
first run?_

## 4. Build & verification order — run the check CI runs

- `pnpm typecheck` resolves `@agent/core` via source paths;
  `pnpm run build:actuators` resolves via dist exports. **They catch
  different errors** — an actuator importing a not-yet-exported core symbol
  passes typecheck and fails the build. Before pushing actuator/core
  boundary changes: `pnpm --filter @agent/core build && pnpm run
build:actuators`.
- Anything invoking `node dist/scripts/...` tests the LAST build. Rebuild
  before trusting behavior.
- **Never mix ts-loader source imports with `@agent/core` dist imports in
  one process** — dual module registries mean two copies of every
  singleton (registered backends silently fall back to stub).
- vitest pool is `forks` on purpose: suites mutate `process.env`
  (KYBERION_ROOT tmp roots, MISSION_ROLE, personas); worker threads share
  env and cross-contaminate.
- Full local battery: `pnpm vitest run libs/core/ scripts/ tests/
libs/actuators/` — plus `pnpm check:catalogs` and, if you touched
  pipelines or goldens, `pnpm run check:golden`.

## 5. Governance & policy mechanics

- File I/O only via `@agent/core` secure-io; writes to `knowledge/**` are
  authorized per identity — a script's authority role derives from its
  filename, `MISSION_ROLE=mission_controller` covers mission-lifecycle
  paths. When a legitimate tool needs a new write path, grant the
  narrowest possible role permission rather than widening an existing one.
- Actuator CLIs exit 0 with `status:"failed"` in stdout — callers parse
  the payload and verify artifacts; exit codes prove nothing.
- Optional platform capabilities (Apple Intelligence, BlackHole, mlx)
  follow **probe-and-degrade**: cached availability probe, every helper
  returns null/skips on failure, an env kill-switch
  (`KYBERION_APPLE_FM=0`-style), and no hard dependency anywhere.
- macOS system frameworks may print loader noise to **stdout** — parse the
  last JSON line, not the whole stream.

## 6. Process discipline for repo work

- One logical change per commit; lint-staged regenerates the knowledge
  index and runs eslint/prettier — expect it to amend what you staged.
- prettier mangles `{{VAR}}` placeholders in scaffolds — scaffold
  directories belong in `.prettierignore`.
- When CI fails: fix the ROOT class, then sweep the repo for siblings of
  the same class (the CJK font fix had to land in three workflows; finding
  only one leaves CI red with the identical signature).
- When HEAD moves under you (parallel sessions are normal here),
  re-inventory with `git status` + grep for your key symbols before
  continuing — never assume your working tree survived.

## Maintenance

When a CI failure or review finding reveals a NEW repo-specific rule (not
an instance of an existing one), add it here in the matching section. Keep
entries as _rules with reasons_, not war stories — the history lives in
git and the improvement-plan docs.
