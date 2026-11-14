---
title: 'Kyberion Development Practices — Hard-Won Rules for Changing This Repo'
last_updated: 2026-11-08
---

# Kyberion Development Practices — Hard-Won Rules for Changing This Repo

**Purpose**: the repo-specific disciplines that changing Kyberion itself
requires — learned the expensive way across the 2026-06/07 hardening
sessions. The general operating philosophy lives in
[working-philosophy](./working-philosophy.md); this document is about THIS
codebase's registration ceremonies, platform traps, and verification order.

**Audience**: anyone (human or agent) writing code in this repository.

---

## Extension boundaries — keep policy out of mechanism

Use the boundary vocabulary precisely:

- A **seam** is the typed contract the stable caller depends on. It names the
  capability and its inputs/outputs without selecting an implementation.
- An **adapter** implements that contract for one external system, provider,
  or host platform. Environment-specific commands, protocols, and lifecycle
  behavior belong here.
- A **resolver/registry** selects an eligible adapter at the composition
  boundary. Adding a supported implementation may require registration here;
  it must not add provider/platform conditionals to the core orchestration
  loop.
- A **facade** gives callers a stable, domain-level operation and hides
  composition and lower-level coordination. It is not a substitute name for
  every interface or adapter.

When extending a capability, first look for an existing seam and follow its
resolver and registration ceremony. Keep orchestration expressed in terms of
the seam. A new implementation should normally add an adapter and its
registration, while the caller remains unchanged. Prefer data-driven
capability declarations when implementations can be described as data; use
typed adapters when behavior or lifecycle differs. Do not create a registry
solely to disguise a conditional if there is only one invariant
implementation.

For example, `scripts/continuous/continuous_owner_process.ts` supervises a process through
the `ContinuousOwnerPlatformAdapter` seam. POSIX process-group handling and the
Windows Job Object wrapper live in platform adapters; the resolver maps the
host platform to an adapter. Supporting another platform requires an adapter
and a resolver entry, not edits to the supervision loop.

## 1. Registration ceremonies — additions are not done until registered

When relocating a core implementation while preserving its public subpath, update the
export target rather than adding a source shim. The root Vitest configuration derives
relocated source aliases from `libs/core/package.json`; keep that mapping ahead of its
directory fallback. Validate both a package build and tests importing the preserved
public subpath, since relative-import tests alone do not exercise export compatibility.

This repo guards its boundaries with contract tests. Adding code without the
matching registration compiles fine locally and then fails CI (or worse,
weakens a boundary silently). Ceremony checklist by change type:

| You added…                                                                                                           | You must also…                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a new `libs/core/*.ts` module used via `@agent/core`                                                                 | export it from `libs/core/index.ts` (typecheck does NOT catch a missing barrel export — `build:actuators` resolves dist and fails on CI only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| a test file that imports `node:fs` directly                                                                          | register it in `tests/fixtures/governance-import-baseline.json` AND `tests/core-fs-exception-boundary.test.ts` `allowedCoreFsImports`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| a `spawnManagedProcess` caller                                                                                       | add it to `tests/process-boundary-governance.test.ts` `allowedManagedProcessConsumers`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| a direct `child_process` import                                                                                      | add it to both `tests/runtime-child-process-boundary.test.ts` and `tests/fixtures/governance-import-baseline.json` (prefer `spawnManagedProcess` instead); the runtime boundary and governance import baseline are separate contracts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| a white-box test import (`../libs/core/x.js` from `tests/`)                                                          | add the specifier to `tests/package-boundary-contract.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| a relative import of `libs/core` from production code outside it (scripts, actuators, satellites, presence, plugins) | import `@agent/core` by package name instead; only bootstrap-class files that build or clean `libs/core/dist` qualify, each listed with a reason in `scripts/check/check_core_single_instance.ts` `CORE_SOURCE_IMPORT_EXCEPTIONS` (gate `core-single-instance`; a stale entry fails it). One process must load one `@agent/core`: mixing source and dist duplicates every module-private registry, so a grant issued by one copy is not honoured by the other                                                                                                                                                                                                                                                                                                                                                                                                            |
| a script that writes governed paths (`knowledge/**`)                                                                 | grant its script-name-derived authority role a **narrowly scoped** `allow_write` in `knowledge/product/governance/security-policy.json` (pattern: `generate_design_tokens`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **any of the above**                                                                                                 | finish the ceremony by RUNNING the matching contract suite (`pnpm vitest run tests/package-boundary-contract.test.ts` etc.) — editing the code without running the gate is how the same failure ships twice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| a new user-facing vocabulary key (`knowledge/product/orchestration/user-facing-vocabulary.json`)                     | add it to the right namespace under `domains` → `pnpm generate:vocabulary-types` → `pnpm check -- --only catalogs`. A locale left untranslated for that key falls back to `default_locale` (or the first available entry) and logs one `[t]`/`[UX_VOCAB]`-prefixed warning per call (`libs/core/localization/t.ts`, `libs/core/localization/ux-vocabulary.ts`) — never invent a second warning style. `pnpm i18n:report` shows per-locale/per-namespace coverage and missing keys but is an instrument, not the gate — it never fails the build.                                                                                                                                                                                                                                                                                                                         |
| a new `pnpm kyberion <verb>`                                                                                         | route it in `scripts/cli.ts` (plus `READ_ONLY_COMMANDS_WITHOUT_RUNTIME_BOOTSTRAP` when it needs no reasoning runtime) AND register it in `knowledge/product/governance/cli-commands.json` (`commands[]` entry + the `operator-cli` entry's command list) — the `scripts/kyberion.ts` dispatcher rejects unregistered verbs with `Unknown kyberion command`, which only a live run shows; add the help line key (`cli_help_<verb>`) → `pnpm generate:pseudo-locale` + `pnpm generate:vocabulary-types`; bump the help length in `scripts/kyberion_home.trust-boundary.test.ts`; update the row in `knowledge/product/orchestration/capability-verb-inventory.md` (en/ja)                                                                                                                                                                                                  |
| a `pathResolver.sharedTmp(` call site                                                                                | register the file and its call count in `knowledge/product/governance/shared-tmp-allowlist.json` (`legit-tmp` only for true consumables; scope-owned artifacts go through `writeScopedArtifact()`) — enforced by `tests/shared-tmp-ratchet.test.ts`, which the `registration-tests` gate of `pnpm check -- --scope pr` runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| a JSON read/write of a state file                                                                                    | use foundation `readJsonIfPresent` / `writeJson`, not `JSON.parse(safeReadFile(...))` — the `foundation-adoption` gate counts the hand-rolled pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| a knowledge document                                                                                                 | `pnpm generate:knowledge-index` (lint-staged does this when knowledge files are staged)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| a new file or intentional remaining debt in an i18n scan root                                                        | run the canonical `pnpm exec tsx scripts/check/check_i18n_hardcoding.ts --update-baseline`, then rerun the normal i18n gate; commit the resulting `knowledge/product/governance/i18n-baseline.json` and regenerated knowledge index together. If the string should be localized, fix the code instead of enlarging the baseline. The same gate (`pr` scope) also freezes `locale_tokens` per file: Japanese regex literals used as matchers (`intent_regex` — use `intent-phrase-lexicon.json`), `=== 'ja'` / `=== 'en'` comparisons (`locale_compare` — use `pickByLocale` / `t()`), hard-coded `ja-JP` / `en-US` tags (`locale_literal` — use `localeToBcp47`) and raw hex / `rgb()` colours in the artifact-engine directories (`engine_hex` — use semantic design tokens). Counts may only go down; annotate a deliberate exception with `// i18n-exempt: <reason>`. |
| a new `@agent/core/<subpath>` import target (e.g. `import … from '@agent/core/x-ledger'`)                            | add a `./x-ledger` entry to `libs/core/package.json` `exports` (alphabetical) — distinct from the `index.ts` barrel: subpath imports resolve through the exports map to `dist/`, and `tsc --noEmit` reports `TS2307` until you both add the entry AND rebuild the core package (`cd libs/core && tsc -p tsconfig.json` or `pnpm build:packages`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| a new actuator op (e.g. `modeling:foo`)                                                                              | `libs/actuators/<actuator>/src/op-catalog.ts` — input contract + `SMOKE_PARAMS` + the op-role list (TRANSFORM_OPS etc.) → handler in the actuator's pipeline-helpers → op enum in `knowledge/product/schemas/<actuator>-pipeline.schema.json` → a runnable `pipelines/<name>.json` + README row + `knowledge/product/governance/orphan-baseline.json` entry + a reachability assertion in `scripts/orphan_op_reachability.test.ts` → regenerate `actuator-op-registry.json` / `actuator-op-discovery.json` / `global_actuator_index.json` / `CAPABILITIES_GUIDE.md` → `pnpm check -- --only orphans,op-registry,pipeline-op-schemas,op-input-contract-coverage,op-effect-coverage`                                                                                                                                                                                       |
| a new standalone `pnpm <noun>:<verb>` package script (`node scripts/run_built.mjs dist/scripts/<file>.js`)           | a `script_commands` entry in `knowledge/product/governance/cli-commands.json` + the `cli_cmd_script_*` key in `knowledge/product/orchestration/user-facing-vocabulary.json` (en/ja/qps-ploc) + bump `MAX_PACKAGE_SCRIPTS` in `scripts/check/check_cli_manifest.ts` (the ratchet moves only with a deliberate operator entrypoint) → run `pnpm vitest run scripts/check/check_cli_manifest.test.ts`; `scriptNameViolation` covers the §1.2 naming rule                                                                                                                                                                                                                                                                                                                                                                                                                    |
| a new governed registry / append-only ledger under `knowledge/confidential/{tenant}/`                                | mirror `libs/core/information-assets/ingest-asset-ledger.ts`: resolve the tenant via `resolveTenant` (fail-closed), append-only JSONL with per-entity version chains, validate every record on append through `defineCatalog` + a schema in `knowledge/product/schemas/`, keep reads skip-corrupt-lines, and gate the ceremony behind `validateReadPermission` on the tenant profile + `KYBERION_BASE_ROLE`/`MISSION_ROLE` identity — see `libs/core/information-assets/security-asset-ledger.ts` for the merge-semantics variant                                                                                                                                                                                                                                                                                                                                        |

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

### 1.2 Package script and command naming

`scripts/check/check_cli_manifest.ts` (the `cli-manifest` gate of `pnpm check -- --scope pr`)
lints every `package.json` script name:

- operator/user scripts are `noun` or `noun:verb` — lowercase kebab segments, at most
  one colon: `stance:create`, `knowledge:ingest`, `tenant:watch-drift`, `agy:sdk-setup`;
- the conventional toolchain families keep their verb-first shape: `build`, `test`,
  `lint`, `format`, `typecheck`, `check`, `generate`, `validate`, `verify`, `ci`,
  `prepare` (and `<family>:<target>`, e.g. `generate:env-registry`, `test:watch`);
- any other name must not start with a verb (`report:*`, `migrate:*`, `export:*`,
  `watch:*`, `onboard`, `ingest` are the shapes it rejects).

Renaming a script or a `kyberion` command never breaks the old name: keep the old
package script as a `deprecated_script_aliases` entry whose body is
`node scripts/deprecated_script_alias.mjs <old> <new> && <new body>` (the check
enforces this; aliases sit outside the package-script ratchet), and keep the old
`kyberion <noun> <verb>` as a `deprecated_command_aliases` entry (the router warns once
and dispatches the replacement). Both lists live in
`knowledge/product/governance/cli-commands.json`.

When adding operations, update the authored discovery count ratchet in
`scripts/generate/generate_op_registry.test.ts` together with the registry and examples.
When production gains content authorization, facade tests must use a real
repository fixture for the input file even when the OCR/model provider is mocked;
a mock provider must not make a nonexistent file a valid authorized input.

## 2. Cross-platform determinism — the Linux CI rules

Every one of these took a red CI round to learn (PR #475):

- **Platform facts come from `libs/core/platform-facts.ts`, not inline
  checks.** Executable suffixes, `where`/`which`, venv layout
  (`Scripts`/`Lib` vs `bin`/`lib`), home env vars, shell invocation, IPC
  transport, path case semantics, symlink types, process-model and media
  capabilities all live in the frozen `PlatformFacts` descriptors —
  `getPlatformFacts(platform)` (injectable) or `platformFacts` (host).
  OS capability _actions_ stay in `libs/core/platform.ts` `OSDriver`; raw
  `process.platform`/`os.platform()` reads outside the platform layer,
  adapter/factory boundaries, and injectable defaults are gate-checked by
  `tests/platform-read-boundary.test.ts` — new reads must be justified in
  that file's allowlist or moved into the facts layer. Probe real
  binaries/capabilities rather than inferring them from the OS token.
- **Never `localeCompare` in generators.** ICU collation differs between
  macOS and Linux; generated files (indexes, catalogs) become
  non-reproducible. Sort by codepoint.
- **Unix socket paths cap at ~104/108 chars.** CI checkout prefixes
  (`/home/runner/work/...`) blow the budget. Sockets go in `os.tmpdir()`
  with short names — this is the one sanctioned exception to the
  `active/shared/tmp/` temp rule.
- **Local IPC is platform-specific.** Node `net` filesystem socket paths fail on
  Windows; route stable socket identities through `resolveLocalIpcAddress()` so
  POSIX keeps UDS and Windows uses a named pipe. A named pipe is not a filesystem
  leaf: health-probe it instead of `exists`/unlink cleanup. Integration tests must
  exercise listen/connect on the host platform, and direct-entry checks must
  normalize separators and case before comparing Windows paths.
  Node's Windows named-pipe default DACL grants read access to Everyone and
  Anonymous. Every application-owned pipe listener must await
  `restrictWindowsNamedPipeAcl()` before advertising readiness or processing a
  client; it replaces and reads back the DACL for the current user, SYSTEM and
  Administrators, and startup fails closed if hardening fails. Keep this behavior
  in the shared core helper and cover its platform guard and failure path in
  `windows-named-pipe-security.test.ts`.
- **Linux runners have no CJK fonts.** Anything exercising CJK rendering
  needs `fonts-noto-cjk` in the workflow (already in ci.yml,
  pr-validation.yml, cross-os.yml — keep new workflows consistent).
- **Golden snapshots**: `baseline-check` is rebaselineable
  (`MISSION_ROLE=mission_controller KYBERION_SUDO=true node
dist/scripts/check/check_golden_output.js --rebaseline`); `vital-check` is
  cross-platform — never rebaseline it from a Mac, macOS-flavored output
  breaks Linux.
- **Heavy suites need explicit timeouts.** Shared runners are ~3-8× slower
  than a dev Mac; anything over ~3s locally gets `{ timeout: 60_000 }`.
  Separate large ledger discovery/retention coverage from per-event durable
  effects: exercise the full horizon through existing dependency ports with
  explicitly labelled terminal-receipt fixtures, and keep a real cross-process
  claim/effect/receipt test large enough to cross the pending-window boundary.
  Assert exact discovered/effect keys, bounded pending state and EOF in both;
  synthetic receipts do not prove real dispatch or effect persistence.
  Give each case a fresh resource path when lock identity includes that path:
  deleting the data directory alone does not isolate locks stored elsewhere.
  Do not weaken production lock recovery or simply raise deadlines to hide a
  timeout cascade. Compare the same baseline shard before calling it pre-existing.
- **Platform-specific behavior is declared, not discovered**:
  `it.skipIf(process.platform !== 'darwin')` for say/mlx/BlackHole-class
  tests, with a comment saying why.

### 2.1 Cross-language determinism — tokenize natural language with the ICU segmenter

Japanese and Chinese have no spaces between words. A tokenizer that splits on
whitespace (`split(/\s+/)`, `split(' ')`) turns a whole Japanese sentence into
ONE token, so any similarity, overlap, dedup or keyword match over it silently
scores 0 (or 1 on an exact repeat) and the feature works only in English
(found reviewing PR #1411: the best-of-providers judge picked the outlier by
input order for every Japanese answer).

- **Set similarity (Jaccard, cosine over hashed tokens)** tokenizes with
  `segmentWords` from `@agent/core/locale-normalize` (ICU `Intl.Segmenter`,
  locale detected from the text). Count every word, single-character CJK words
  included, and split ICU-joined `config.json`-style runs afterwards if needed.
- **Keyword / substring matching (query terms, trigger phrases, cue
  overlap)** uses `segmentKeywordTerms`: Latin chunks stay verbatim (so
  `deploy` still matches `deployment`), spaceless-script chunks become content
  words — hiragana-only particles/auxiliaries and one-character non-kanji
  segments are dropped because they match almost anything; a single kanji is
  kept.
- **Persisted vectors**: changing the tokenizer of an embedding changes its
  vector space. Bump the backend's `cacheKey` (for example
  `LOCAL_HASH_EMBEDDING_CACHE_KEY`) so the knowledge-index disk cache never
  compares old document vectors with new query vectors.
- **Leave whitespace splits that parse structure** — CLI args, cron fields,
  identifiers, code, paths, command lines — and word counts that already have
  a language-pack path for spaceless scripts.
- **Gate**: `tests/text-similarity-tokenization-boundary.test.ts`
  (`registration-tests`) flags whitespace-only `split` in any source file that
  defines a jaccard / similarity / overlap function. Fix the tokenizer; register
  a justified exception in its `ALLOWED_WHITESPACE_SPLITS` with the exact count
  and a reason.
- **Test with Japanese input.** Every converted site carries a regression test
  with a Japanese sentence that fails under the whitespace tokenizer.

## 3. Hermetic tests — the machine is not a fixture

How-to with examples: [docs/developer/WRITING_TESTS.md](../../../docs/developer/WRITING_TESTS.md).

Recurrence-prevention rules for operational defects (CI workflows, runtime stores, daemons,
library stdout, test pollution, tenant-scoped facades, LLM/provider calls, generators overwriting
mission evidence, project lifecycle facades, secure-io canonicalization, actuator failure
receipts) and the gates that enforce them:
[operations-hygiene-runbook](./operations-hygiene-runbook.md).

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
- **live operational subtrees, whoever the writer is** — under Vitest,
  `path-resolver` maps delivery outboxes and channel logs
  (`coordination/channels`, `observability/channels`), audit evidence
  (`logs/audit`, `active/audit`), ops alerts, the inbox, peer mailboxes, task
  sessions, work coordination, the feedback loop, tenants, traces and the other
  internal runtime stores listed in `VITEST_LIVE_SUBTREES` into
  `active/shared/runtime/vitest-live/pool-<n>/` (reads and
  writes alike; skipped when a test sets its own `KYBERION_ROOT`). The
  per-writer gates above leaked again as new writers appeared — a full run
  still grew the live inbox, audit log and Telegram/Discord outboxes — so
  the sandbox sits at the path layer instead. Assert paths with
  `pathResolver` (or a sub-path such as `/coordination/channels/…`), never
  `path.join(root, 'active/…')` plus raw `fs`;
- **leaks are reported, not silent** — `tests/vitest-active-leak-guard.ts`
  (Vitest `globalSetup`) lists every file a run created or grew in live
  `active/` outside `active/shared/tmp`, `active/shared/cache` and
  `vitest-*` roots, and in the gitignored `knowledge/personal/`,
  `knowledge/confidential/` and `customer/` trees, in
  `active/shared/tmp/vitest-active-leaks.json`;
  `KYBERION_TEST_LEAK_STRICT=1` fails the run. Growth whose appended rows are
  all stamped agent-session hook rows (audit rows, plus the Stop hook's
  `claude-code-cli` metrics usage row) is listed as `session_hook_appends`
  instead, so a run an agent starts in its own checkout passes. A released lock
  under `active/shared/runtime/locks/` is dropped. Any other row, a replaced
  file, co-session growth and every other created file still fail; the full
  table is in WRITING_TESTS "Runs started by an agent session". Check it after a full run;
- **the calendar** — absolute dates in fixtures rot; freeze
  `vi.useFakeTimers({ now, toFake: ['Date'] })` for the WHOLE flow, not
  just the assertion phase.
- **the wall clock's speed** — a real sleep in a test (`new Promise((r) =>
setTimeout(r, N))`, `await sleep(N)`) races a TTL, a deadline or a
  background worker, and a loaded CI runner loses the race (#1186: a 1 ms
  TTL raced the assertion in `peer-task-exchange.test.ts`). The
  `test-sleep-ratchet` gate (`pnpm check -- --only test-sleep-ratchet`, baseline
  `scripts/check/check_test_sleep_ratchet.baseline.json`) counts them per test file
  and fails when a file gains one; event-loop yields (`setTimeout(r, 0)`,
  `setImmediate`) and timeout guards (`setTimeout(() => reject(…), N)`) are
  not counted. Fix by shape: TTL / expiry / lease → long TTL or
  `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(Date.now() + ms)`;
  timer-driven code → `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(ms)`;
  "wait until it happened" → `await vi.waitFor(() => expect(…))`;
  late completion vs a deadline → hold the work on a deferred promise and
  release it after the deadline fired; code that reads the clock → inject a
  clock (`deps.clock`, a `now` option). After removing sleeps, lower the
  baseline with `node --import ./scripts/ts-loader.mjs scripts/check/check_test_sleep_ratchet.ts --write-baseline`.

Smell test: _would this pass in a fresh clone on a different OS on the
first run?_

**Known non-hermetic suites (until fixed).** A parallel full run
(`pnpm vitest run libs/core scripts tests`) can fail or dirty the tree for
reasons unrelated to your change: `scripts/check/check_governance_rules.test.ts`
writes `knowledge/product/governance/test-governance-deterministic.json` into
the real governance directory (so `scripts/check/check_contract_schemas.test.ts`
fails if it runs meanwhile), and `libs/core/knowledge/memory-promotion-workflow.test.ts`
can append a `MEM-…` note (evidence `MSN-TEST-AUTOPROMOTE`) to the real
`knowledge/product/governance/HINTS.md`. Rerun a failing file
in isolation before trusting it, and check `git status` after every full run —
never commit that residue.

**The tier guard is not a fixture either.** Tests that point `rootDir`
under `active/shared/tmp/` are default-allowed, so code that reads or writes
`knowledge/personal/**` or `knowledge/confidential/**` passes there and is
denied on a real root (this broke a CLI, a janitor sweep that silently
expired nothing, and rules silently ignored from a tier the reader could not
see). Before calling such code done, run it once through its real entry
point (CLI, janitor, worker, surface) against the real root. Wrap each
synchronous disk call in `withExecutionContext(role, fn)` — it restores the
context as soon as `fn` returns, so never wrap an `await`; use
`withExecutionContextAsync` across awaits. The assumed role and persona live
in an AsyncLocalStorage scope that outranks `SYSTEM_ROLE` and is isolated per
async context. Only the synchronous helper mirrors it into the
`MISSION_ROLE` / `KYBERION_BASE_ROLE` env vars (a compatibility mirror for
attribution labels); the async helper never does, so authorization code must
resolve the role through `resolveRole()` / `resolveIdentityContext()` /
`resolveExecutionBaseRole()`, never read the env, and child envs must come
from `buildExecutionEnv()` / `buildSafeExecEnv()`.
Under `SYSTEM_ROLE` (every surface launched by surface_runtime) a role must be
allowed by `role-assumption-policy.json` or the assumption throws
`[ROLE_ASSUMPTION_DENIED]` — see
[AUTHORITY_MODEL §3.B2](./AUTHORITY_MODEL.md). Data a runtime role must read
must live where that role can read it, and an unreadable overlay must warn,
not drop silently.

## 4. Build & verification order — run the check CI runs

- **One compiler owns each output.** tsconfig.base.json contains language
  options only. tsconfig.packages.json builds core/shared libraries and
  terminal-hud into package-local dist/, each with its own .tsbuildinfo.
  The root runtime compiler owns scripts, remaining presence sources, satellites
  and actuators together: system-actuator and root scripts import each other, so
  splitting those projects would create a reference cycle. Actuator and satellite
  package build commands delegate this same runtime target rather than emitting
  a second tree. Cross-owner imports use package exports, never relative source.
- **Build, clean and freshness checks share ownership.** Keep
  scripts/build-output-layout.ts, project references and package entrypoints
  aligned. Clean removes only declared output directories and legacy incremental
  records; it never searches other worktrees or arbitrary user buildinfo files.
  The physical source-shadow guard sees ignored and untracked JS/declarations/maps,
  with exact documented exceptions for intentional source inputs.
  A new workspace package that emits a dist (e.g. libs/kernel) is registered in
  PACKAGE_BUILD_OUTPUTS and in the build-artifact upload paths of ci.yml,
  pr-validation.yml and cross-os.yml in the same PR: downstream jobs restore
  that artifact instead of rebuilding, so an unlisted dist fails only at
  runtime there (tests/build-output-ownership.test.ts enforces both).
- **An incremental build is not a clean build.** TypeScript can retain obsolete
  outputs after deletion/rename, or trust buildinfo after a partial output wipe.
  Freshness checks verify input hashes, required emits and obsolete outputs;
  use pnpm build to clean all owned outputs and metadata together.
  tests/build-output-incremental.test.ts exercises clean, ordered, incremental,
  add/delete/rename and runtime behavior with the real compiler.
- **Bundles are a final, separate output stage.** build:repo builds the runtime
  graph and then emits explicit .bundle.js siblings. It never overwrites tsc
  output. Original dist/scripts/*.js launch paths remain valid; package commands
  select registered bundles whose direct-entry guards accept their exact names.
- Anything invoking node dist/scripts/... tests the LAST build. Rebuild
  before trusting behavior. The source loader also resolves existing workspace
  dist exports, so a stale library must be rebuilt before a source CLI is tested.
- **Never mix ts-loader source imports with `@agent/core` dist imports in
  one process** — dual module registries mean two copies of every
  singleton (registered backends silently fall back to stub, opaque store
  grants issued by one copy are refused by the other). `scripts/ts-loader.mjs`
  chooses dist or source once per process (the first `@agent/core` import, or
  a bootstrap script's first relative core import) and never answers a missing
  dist subpath from source; the `core-single-instance` gate forbids relative
  core imports outside the listed bootstrap files.
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
- Actuator one-shot CLIs preserve failed/denied result payloads and exit nonzero;
  resident CLIs set `ok:false` on failed results. Callers still inspect command
  exit codes within terminal results and verify artifacts. Follow
  [operations-hygiene-runbook §11](./operations-hygiene-runbook.md#11-actuator-failure-receipts-and-terminal-capabilities).
- Optional platform capabilities (Apple Intelligence, BlackHole, mlx)
  follow **probe-and-degrade**: cached availability probe, every helper
  returns null/skips on failure, an env kill-switch
  (`KYBERION_APPLE_FM=0`-style), and no hard dependency anywhere.
- macOS system frameworks may print loader noise to **stdout** — parse the
  last JSON line, not the whole stream.
- **Compare canonicalized team roles, not raw strings.** Team-template role
  names (`knowledge/product/orchestration/mission-team-templates.json`, e.g.
  `tester`, `experience_designer`) are not always the canonical addendum key
  (`qa`, `designer`) that `libs/core/workforce/working-principles.ts` resolves. A check
  like `input.teamRole === 'qa'` silently misses `tester` tasks. Always
  compare `canonicalizeTeamRole(teamRole)` (exported from
  `working-principles.ts`) instead of the raw `teamRole` string — this bit
  `prepareArtifactReviewTask` gating and artifact-review-receipt persistence
  in `mission-orchestration-worker.ts` (fixed 2026-07).

- **Detect an external answer by content, not by existence or clocks.**
  When a flow hands work to someone else and collects the result on a rerun
  (host image hand-off, `libs/shared-media/src/host-image-handoff.ts`), record the
  target's content hash (or its absence) when the request is made, and
  collect only when the content differs — for the same request (prompt).
  File existence attributes stale files to the helper; comparing mtimes
  against a request time loses to 1 s mtime granularity and to
  timestamp-preserving copies. Keep collection idempotent and a same-request
  re-request non-destructive, so multi-pass resumes (avatar sets) do not
  re-request finished parts or orphan an answer written in between.

- **Moving a route to another process re-checks its path authority.** Each
  surface process runs under its own `SYSTEM_ROLE`, and secure-io authorizes
  paths per role. A handler that worked in one process (presence-studio) can
  fail with `ROLE_VIOLATION` in another (Concierge), for example when it
  writes `knowledge/personal/`. Route tests that mock core cannot see this.
  Before moving such a handler, run its real read and write once under the
  target role, e.g. `SYSTEM_ROLE=concierge node <script>` against the
  built `libs/core/dist`. Then wrap it in `withExecutionContext(<role>)` using
  a role the process already may assume (`role-assumption-policy.json`), and
  name the route in that role's rationale. Never widen the process role.
  (MSN-SERVER-STUDIO-P2A-20261106: the voice selection save.)
- **A moved route keeps the old gate's exact checks, not just the role.**
  Surfaces describe a viewer differently: Studio's local-admin gate checks
  `source === 'loopback'`, while a Concierge `role === 'localadmin'` is also
  reachable through a remote token. Port each condition the old gate tested,
  and pin a remote-token case in a test. Run the route's own refusals before
  the shared mutation guard, and return an `error_code` the page maps to its
  own copy. Otherwise the person sees the guard's internal English text.
  (MSN-SERVER-STUDIO-HELP-20261107: 使い方 mark-done.)
- **"The local owner" is not the credential source on Concierge.**
  Studio treats every credential-free loopback request as localadmin. On
  Concierge a credential-free loopback viewer exists only during bootstrap or
  with the anonymous-loopback escape hatch. Once an owner is bound, the
  browser sends its session, so the viewer's `source` is `token`. Decide "the
  owner of this machine" with `resolveConciergeInstallationAccess` (attested
  loopback peer plus the bound owner's principal), never with
  `viewer.source === 'loopback'`. Test the signed-in owner, not only a
  synthetic loopback viewer. (MSN-SERVER-STUDIO-PROGRESS-20261107: the
  owner's personal 業務の自動化候補.) Shared core functions take that decision
  as an explicit input (`HearingOwnerInput { owner }` in
  `libs/core/surface/hearing-scope.ts`); each surface adapter computes it, and
  core never reads the credential source to decide it.
  (MSN-SERVER-CONCIERGE-ASK-20261108: the hearing routes.)
- **Deleting the old surface's tests can delete core coverage.** A surface's
  route or client tests often exercise `libs/core` logic for real, while the
  core package's own tests mock that module. Before deleting them, list each
  case that reaches unmocked core code. Move those cases into a core test
  (no HTTP), and port the client harness cases whose behaviour was ported.
  For each case you drop, record why. Check the result by removing guard
  conditions one at a time: a mutant that survives marks lost coverage.
  (MSN-SERVER-STUDIO-FIRST-JOB-20261108: 初めての仕事.)
- **A feature a surface may not serve fails closed on the resolved value.**
  When a shared step serves a feature only if the surface supplies a
  capability (a reader, a role), refusing the request field that names it is
  not enough. The same value can arrive another way: a stored record, a
  legacy inline object, a different parameter. Check the resolved value
  after every load and before any effect, model call or admitted audit. Test
  each arrival path with the capability absent, and seed a stored record.
  (MSN-SERVER-CONCIERGE-ASK-20261108: decision-ledger hearings on Concierge;
  review found the stored and inline paths in two rounds.)

## 6. Process discipline for repo work

- One logical change per commit; lint-staged regenerates the knowledge
  index and runs eslint/prettier — expect it to amend what you staged.
  lint-staged stashes unstaged changes, so while other agents edit the
  same worktree, do the hook's work yourself **before** committing:
  1. run `eslint --fix --max-warnings 0` and `prettier --write` on the paths
     you will stage;
  2. for any `knowledge/` edit, run `pnpm generate:knowledge-index` (it also
     picks up other agents' uncommitted knowledge edits — check the diff);
  3. stage explicit paths plus `knowledge/_index.md` (the size manifest
     `knowledge/_integrity-manifest.json` is gitignored), and confirm no newly added
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
  `pnpm check -- --changed` and the affected tests (`pnpm exec vitest run --changed origin/main`)
  plus the exception-table rows for your changed paths, then its PR creation steps (push, base `main`,
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

### 6.1 Generated files and merges

Parallel PRs used to conflict on generated files every day. The rules that
keep them mergeable:

- **Untracked when nothing needs the committed copy.**
  `knowledge/_integrity-manifest.json` (a size inventory with no runtime or
  tamper-check consumer) is gitignored and rebuilt by `pnpm build`
  (`generate_knowledge_index --manifest-only`, which never rewrites the
  tracked `_index.md`, so a build cannot hide a stale index from the gate).
- **Check the invariant, not a snapshot.** The role-assumption reachability
  report (RN-02, ~800 KB) is computed in memory: the `role-assumption-reachability`
  PR gate (`scripts/analyze_role_assumptions.ts`) fails only on RN-03
  invariant violations — a reachable role not granted in
  `role-assumption-policy.json`, a policy/analysis system-role mismatch, a
  launched `SYSTEM_ROLE` without analysis, or a narrowed role that is no
  longer fully resolved — with one diagnostic per violation. `--write-report`
  writes the full report to `active/shared/cache/system/role-assumption/reachability.json`
  for review; it is never committed. Prefer this shape whenever a committed
  generated file exists only to be diffed by a gate.
- **Fragments instead of a shared file.** PRs never edit `CHANGELOG.md`; they
  add `changelog.d/<short-slug>.md` (`category:` front-matter + list items,
  validated by the `changelog-fragments` PR gate). The release runs
  `pnpm kyberion changelog assemble` to fold them into `[Unreleased]`.
- **Regenerate, don't hand-merge, the files that stay tracked.**
  `knowledge/_index.md`, `docs/developer/CONFIGURATION.md` and
  `docs/developer/env.example` (plus the curated `env-registry.json`) carry
  `merge=kyberion-regenerate` in `.gitattributes`.
- **After any merge or rebase that touched them, run
  `pnpm kyberion resolve generated`.** It works without any merge driver:
  unmerged generated files are first rebuilt from their index conflict stages
  (`:1:` base, `:2:` ours, `:3:` theirs) — derived files by text merge else
  our side, `env-registry.json` entry-by-entry by name — then it regenerates
  **every committed, CI-drift-checked generated file** in dependency order
  (op-registry → pseudo-locale → vocabulary-types → pii-rules → cli-reference
  → capability-seams → subagent definitions → provider hooks → env registry →
  knowledge index), validates the changelog
  fragments and stages the results (`--check` is read-only and lists every
  drifted file; `--no-stage` skips `git add`). Never run the individual
  `generate:*` commands by hand to chase a freshness gate — this one command
  regenerates everything. The `.husky/pre-push` hook runs
  `--check --fast` (`--fast` skips any step marked `slow`; none is today) and
  prints the fix command;
  `KYBERION_SKIP_PRE_PUSH=1 git push` skips it once. Only an `env-registry.json` entry changed
  differently on both sides needs a human: edit its markers keeping both
  descriptions' intent, then rerun. The `post-merge` hook reminds you when
  both sides of a completed merge changed a generated file.
- **Optional merge driver — a one-time repository-owner step, never
  automatic.** Repo config belongs to the mission owner (AGENTS.md §1) and
  the repo-local config is shared by every linked worktree and agent CLI, so
  `pnpm install` does not touch it. The owner may run
  `pnpm kyberion resolve install-driver` (`--uninstall` reverts; it prints the
  exact `git config --local merge.kyberion-regenerate.*` keys it sets and is
  a no-op in CI, outside a git checkout and in a nested checkout). With it,
  `git merge` never stops on these files: derived files keep a clean text
  merge or our side, `env-registry.json` is merged by name. Without it, git's
  normal text merge leaves conflict markers and `resolve generated` repairs
  them; `resolve generated` prints a one-line hint while it is missing.
- **Limits.** GitHub's conflict detection and web editor ignore custom
  drivers, so a PR can still show "conflicts" there: merge `main` locally,
  run `resolve generated`, push. Rebases use the driver (when installed) but
  run no `post-merge` hook. Only regeneration makes a merge correct, and the
  freshness gates (`env-registry`, `catalogs`) are what enforce it.
- **Adding a tracked generated file or generator**: add a step (script,
  tracked outputs, `after` dependencies) to `GENERATED_ARTIFACT_STEPS` in
  `scripts/resolve_generated.ts`; for a file with a `.gitattributes`
  `merge=kyberion-regenerate` line, mark the step `mergeDriver: true`.
  `scripts/resolve_generated.test.ts` fails when a generator `--check` gate in
  `ci-gates.json` has no step, when the merge-driver lists differ, or when a
  step runs before a step it depends on.

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
  `libs/core/analysis/trace.ts`).
- **Tighten monotonically, never replace.** A security floor (posture,
  approval requirements) is applied as a union on top of the base
  resolution — an early-return floor that REPLACES stronger requirements
  is a downgrade wearing a strict label (`resolveApprovalPolicy`).

## Recurring agent mistakes → structural fixes

When the operator corrects agents for the **same** coding or procedure mistake
twice or more, do not add another paragraph of instructions first. Follow
[agent-mistake-correction-playbook](../orchestration/agent-mistake-correction-playbook.md):
architecture → types → lint/CI → tests → docs last; prove each gate on a real
past failure; keep a rule↔enforcement row here or in
[operations-hygiene-runbook](./operations-hygiene-runbook.md). That playbook is
the pstack `/correct` distillation for this repo.

## Maintenance

When a CI failure or review finding reveals a NEW repo-specific rule (not
an instance of an existing one), add it here in the matching section. Keep
entries as _rules with reasons_, not war stories — the history lives in
git and the improvement-plan docs.

Dot execution changes must preserve [timed-out effect ownership and executor continuation](./operations-hygiene-runbook.md#13-timed-out-effects-and-executor-continuation), including isolated delayed-write and process-restart evidence.
