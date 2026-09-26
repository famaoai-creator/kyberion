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

| You added…                                                                                       | You must also…                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a new `libs/core/*.ts` module used via `@agent/core`                                             | export it from `libs/core/index.ts` (typecheck does NOT catch a missing barrel export — `build:actuators` resolves dist and fails on CI only)                                                                                                                                                                                                                                                                                                                                                                                   |
| a test file that imports `node:fs` directly                                                      | register it in `tests/fixtures/governance-import-baseline.json` AND `tests/core-fs-exception-boundary.test.ts` `allowedCoreFsImports`                                                                                                                                                                                                                                                                                                                                                                                           |
| a `spawnManagedProcess` caller                                                                   | add it to `tests/process-boundary-governance.test.ts` `allowedManagedProcessConsumers`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| a direct `child_process` import                                                                  | add it to both `tests/runtime-child-process-boundary.test.ts` and `tests/fixtures/governance-import-baseline.json` (prefer `spawnManagedProcess` instead); the runtime boundary and governance import baseline are separate contracts                                                                                                                                                                                                                                                                                           |
| a white-box test import (`../libs/core/x.js` from `tests/`)                                      | add the specifier to `tests/package-boundary-contract.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| a workspace-source import from `scripts/`                                                        | justify it in `scripts/check_esm_integrity.ts` `ALLOWED_WORKSPACE_SOURCE_IMPORT_FILES` (only bootstrap-class scripts qualify — see `scripts/clean.ts`)                                                                                                                                                                                                                                                                                                                                                                          |
| a script that writes governed paths (`knowledge/**`)                                             | grant its script-name-derived authority role a **narrowly scoped** `allow_write` in `knowledge/product/governance/security-policy.json` (pattern: `generate_design_tokens`)                                                                                                                                                                                                                                                                                                                                                     |
| **any of the above**                                                                             | finish the ceremony by RUNNING the matching contract suite (`pnpm vitest run tests/package-boundary-contract.test.ts` etc.) — editing the code without running the gate is how the same failure ships twice                                                                                                                                                                                                                                                                                                                     |
| a new user-facing vocabulary key (`knowledge/product/orchestration/user-facing-vocabulary.json`) | add it to the right namespace under `domains` → `pnpm generate:vocabulary-types` → `pnpm check -- --only catalogs`. A locale left untranslated for that key falls back to `default_locale` (or the first available entry) and logs one `[t]`/`[UX_VOCAB]`-prefixed warning per call (`libs/core/t.ts`, `libs/core/ux-vocabulary.ts`) — never invent a second warning style. `pnpm report:i18n-coverage` shows per-locale/per-namespace coverage and missing keys but is an instrument, not the gate — it never fails the build. |
| a knowledge document                                                                             | `pnpm generate:knowledge-index` (lint-staged does this when knowledge files are staged)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| a new file or intentional remaining debt in an i18n scan root                                    | run the canonical `pnpm exec tsx scripts/check_i18n_hardcoding.ts --update-baseline`, then rerun the normal i18n gate; commit the resulting `knowledge/product/governance/i18n-baseline.json` and regenerated knowledge index together. If the string should be localized, fix the code instead of enlarging the baseline.                                                                                                                                                                                                      |

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
- **production shared stores** — a writer to a repo-wide store must not
  reach the real store under vitest: traces skip the shared log unless the
  caller passes a `dir` or sets `KYBERION_TRACE_TEST_PERSIST=1`, and the
  audit chain redirects to the injected test IO. `vi.mock` of secure-io does
  not intercept foundation JSON IO, so an unguarded writer leaked test traces
  into production and skewed work-inventory demand signals;
- **the calendar** — absolute dates in fixtures rot; freeze
  `vi.useFakeTimers({ now, toFake: ['Date'] })` for the WHOLE flow, not
  just the assertion phase.

Smell test: _would this pass in a fresh clone on a different OS on the
first run?_

**The tier guard is not a fixture either.** Tests that point `rootDir`
under `active/shared/tmp/` are default-allowed, so code that reads or writes
`knowledge/personal/**` or `knowledge/confidential/**` passes there and is
denied on a real root (this broke a CLI, a janitor sweep that silently
expired nothing, and rules silently ignored from a tier the reader could not
see). Before calling such code done, run it once through its real entry
point (CLI, janitor, worker, surface) against the real root. Wrap each
synchronous disk call in `withExecutionContext(role, fn)` — it restores the
context as soon as `fn` returns, so never wrap an `await`; use
`withExecutionContextAsync` across awaits — it swaps the process-global
`MISSION_ROLE` for the whole await, so concurrent async flows in one process
see each other's role. Data a runtime role must read
must live where that role can read it, and an unreadable overlay must warn,
not drop silently.

## 4. Build & verification order — run the check CI runs

- `pnpm typecheck` resolves `@agent/core` via source paths;
  `pnpm run build:actuators` resolves via dist exports. **They catch
  different errors** — an actuator importing a not-yet-exported core symbol
  passes typecheck and fails the build. Before pushing actuator/core
  boundary changes: `pnpm --filter @agent/core build && pnpm run
build:actuators`.
- Anything invoking `node dist/scripts/...` tests the LAST build. Rebuild
  before trusting behavior. Scratch scripts run via `node --import
./scripts/ts-loader.mjs` hit the same rule: `@agent/core/*` specifiers
  resolve to `libs/core/dist/` whenever a build exists, so edits under
  `libs/core/src/` are invisible until `pnpm --filter @agent/core build`.
- **Never mix ts-loader source imports with `@agent/core` dist imports in
  one process** — dual module registries mean two copies of every
  singleton (registered backends silently fall back to stub).
- **Catalog directories shadow their sibling `.json` index.** Catalog
  loaders (`loadThemeCatalog`, `loadMediaDesignSystemsCatalog`) merge the
  recursively-read directory (`media-templates/themes/`,
  `media-templates/media-design-systems/`) and only fall back to the
  sibling `themes.json` / `media-design-systems.json` when the directory is
  empty. Add or edit entries in the **directory** files — the top-level
  `.json` is a mirror and silently ignored otherwise.
- **Slide-layout catalogs are token-first.** `body-zone-layouts.json` (and
  any layout template catalog) may carry a `tokens` table
  (`tokens.spacing`/`tokens.typography` — inches / pt); zone, chrome and hero
  fields reference them as `@spacing.md`, `@typography.title`, `@font.body`,
  `@color.surface`. Resolution is theme-first, then the catalog tokens, so a
  theme's own `spacing`/`typography` keys retune the whole layout system
  without touching geometry. Never put raw font sizes or spacing literals in
  new zone specs — add a token or use the nearest existing ref.
- vitest pool is `forks` on purpose: suites mutate `process.env`
  (KYBERION_ROOT tmp roots, MISSION_ROLE, personas); worker threads share
  env and cross-contaminate.
- Full local battery: `pnpm vitest run libs/core/ scripts/ tests/
libs/actuators/` — plus `pnpm check -- --only catalogs` and, if you touched
  pipelines or goldens, `pnpm check -- --scope pr --only golden`.
- **One heavy run per worktree at a time.** Never run the `golden` /
  vital-check gate while vitest runs in the same worktree — the suite
  deletes fixtures the golden reads. Rerun any full-suite timeout or flake
  in isolation and report both results; name pre-existing failures as
  pre-existing (with test names) instead of counting them as passes.
- **Verify static-analysis fixes locally.** PR code scanning reports only
  alerts on changed lines, and moving a sink makes pre-existing alerts show
  as new. Confirm a CodeQL fix with the local CodeQL CLI over the same scope
  GitHub scans (test files included) before pushing.

## 5. Governance & policy mechanics

- File I/O only via `@agent/core` secure-io; writes to `knowledge/**` are
  authorized per identity — a script's authority role derives from its
  filename, `MISSION_ROLE=mission_controller` covers mission-lifecycle
  paths. When a legitimate tool needs a new write path, grant the
  narrowest possible role permission rather than widening an existing one.
- **Shell scripts go through `safeExecShellScript*` only.** Never pass a
  literal `sh` / `bash` / `cmd` with `-c` / `/c` to the generic
  `safeExec*` / `safeSpawn` helpers — not even in a test that proves the call
  is rejected. CodeQL's context-insensitive `IndirectCommandArgument` model
  then treats every argument of those helpers as shell-interpreted and flags
  every caller (698 false alerts before the split).
- Actuator CLIs exit 0 with `status:"failed"` in stdout — callers parse
  the payload and verify artifacts; exit codes prove nothing.
- Optional platform capabilities (Apple Intelligence, BlackHole, mlx)
  follow **probe-and-degrade**: cached availability probe, every helper
  returns null/skips on failure, an env kill-switch
  (`KYBERION_APPLE_FM=0`-style), and no hard dependency anywhere.
- macOS system frameworks may print loader noise to **stdout** — parse the
  last JSON line, not the whole stream.
- **Compare canonicalized team roles, not raw strings.** Team-template role
  names (`knowledge/product/orchestration/mission-team-templates.json`, e.g.
  `tester`, `experience_designer`) are not always the canonical addendum key
  (`qa`, `designer`) that `libs/core/working-principles.ts` resolves. A check
  like `input.teamRole === 'qa'` silently misses `tester` tasks. Always
  compare `canonicalizeTeamRole(teamRole)` (exported from
  `working-principles.ts`) instead of the raw `teamRole` string — this bit
  `prepareArtifactReviewTask` gating and artifact-review-receipt persistence
  in `mission-orchestration-worker.ts` (fixed 2026-07).

## 6. Process discipline for repo work

- One logical change per commit; lint-staged regenerates the knowledge
  index and runs eslint/prettier — expect it to amend what you staged.
  lint-staged stashes unstaged changes, so while other agents edit the
  same worktree, do the hook's work yourself **before** committing:
  1. run `eslint --fix --max-warnings 0` and `prettier --write` on the paths
     you will stage;
  2. for any `knowledge/` edit, run `pnpm generate:knowledge-index` (it also
     picks up other agents' uncommitted knowledge edits — check the diff);
  3. stage explicit paths plus `knowledge/_index.md` and
     `knowledge/_integrity-manifest.json`, and confirm no newly added
     `.js`/`.d.ts` shadows a `.ts` source (the `.husky/pre-commit` check);
  4. only then `git -c core.hooksPath=/dev/null commit`.
- Set up every new worktree from scratch (install with
  `CI=true pnpm install --frozen-lockfile`, then `pnpm build`). Never
  symlink the main checkout's `node_modules`; if `pnpm exec` misbehaves in
  a worktree, call `./node_modules/.bin/*` directly.
- prettier mangles `{{VAR}}` placeholders in scaffolds — scaffold
  directories belong in `.prettierignore`.
- When CI fails: fix the ROOT class, then sweep the repo for siblings of
  the same class (the CJK font fix had to land in three workflows; finding
  only one leaves CI red with the identical signature).
- When HEAD moves under you (parallel sessions are normal here),
  re-inventory with `git status` + grep for your key symbols before
  continuing — never assume your working tree survived.
- **Before opening a PR**, follow
  [pre-pr-ci-readiness-checklist.ja.md](./pre-pr-ci-readiness-checklist.ja.md):
  `pnpm check -- --scope pr` plus the exception-table rows for your
  changed paths, then its PR creation steps (push, base `main`,
  `pnpm kyberion pr create --title ... --body-file ...`). Do not treat
  pending CI as green.

The CI boundary checks are deliberately layered. A new runtime module can
need both a source-level allowlist and a JSON baseline even when the code
typechecks and the focused runtime test passes. Likewise, an i18n baseline
update can pass locally while a full-scope CI run still exposes a newly
scanned file or stale generated index. When a gate reports baseline drift,
use its canonical generator, inspect the complete generated diff, run the
matching focused test, and rerun the PR-scope check before pushing. Do not
infer remote CI success from local checks or from a pending status.

## 7. Design principles adopted from qm (QM adoption plan §3)

Patterns proven in yc-software/qm and adopted as repo-wide discipline
(implementation examples cited so the rule stays checkable):

- **Fail-open is a first-class, audited, labelled state.** Never a silent
  `catch {}` — a degraded path must tell its consumers it degraded, with a
  source label, and leave an audit entry (example: the unscreened notice +
  `input_failed_open` audit in `untrusted-content.ts`).
- **Policy is small pure functions with dedicated tests.** Keep judgment
  logic out of I/O so it can be pinned standalone (examples:
  `composeSecurityPosture`, `routeWake`-style arbitration,
  `errorParks`-style counters).
- **Truncated means unscannable, not partially checked.** Past a size cap,
  report "could not be checked" — never "checked what fit" (examples: the
  screen-payload elision marker, the 64KB shell-command cap).
- **Resolution keys are immutable — no renames.** Assets resolved by name
  (skills, pipeline ids, schedule ids) are created-new + archived, never
  renamed in place; renaming the key breaks every reference silently.
- **Docs state limitations, and tests keep them honest.** Security-relevant
  docs enumerate what is NOT enforced (clause status tables:
  `docs/PACKAGING_CONTRACT.md`), and `tests/docs-honesty-contract.test.ts`
  asserts the load-bearing claims against the code.
- **Asymmetric trust for de-obfuscation.** Seeing through quotes, wrappers
  and encodings is correct when looking for something to BLOCK, and wrong
  when looking for a reason to PERMIT (`shell-command-normalize.ts`).
- **`MISSION_ROLE` is an authority role, not an identity.** It authorizes
  file access (`resolveRole()`), but `pnpm pipeline` and every
  `withExecutionContext` set it for ordinary human runs, so never infer who
  started a run from it — trace origin marks a run `agent` only when
  `KYBERION_NHI_ID` / `KYBERION_AGENT_ID` is set (`deriveTraceOrigin` in
  `libs/core/src/trace.ts`).
- **Tighten monotonically, never replace.** A security floor (posture,
  approval requirements) is applied as a union on top of the base
  resolution — an early-return floor that REPLACES stronger requirements
  is a downgrade wearing a strict label (`resolveApprovalPolicy`).

## Maintenance

When a CI failure or review finding reveals a NEW repo-specific rule (not
an instance of an existing one), add it here in the matching section. Keep
entries as _rules with reasons_, not war stories — the history lives in
git and the improvement-plan docs.
