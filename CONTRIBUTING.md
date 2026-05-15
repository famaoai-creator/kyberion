# Contributing to Kyberion

Thanks for your interest. Kyberion is OSS, in active pre-1.0 development.

This document is the PR contract. For the architectural picture, read [`docs/developer/TOUR.md`](./docs/developer/TOUR.md) first.

## Quick start

```bash
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion
pnpm install                # install workspace deps
pnpm build                  # compile everything
pnpm doctor                 # verify ecosystem health
pnpm test:core              # run core unit tests
```

If `pnpm doctor` is green and `pnpm test:core` passes, you're set.

For deeper setup (voice, surfaces, customer overlay), see [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) and [`docs/operator/DEPLOYMENT.md`](./docs/operator/DEPLOYMENT.md).

## Pre-PR checklist

Before opening a PR:

- [ ] `pnpm validate` is green locally (build + typecheck + ESM check + contract checks + tests).
- [ ] New code has at least one test (unit, integration, or contract — whatever fits).
- [ ] You've read [`docs/developer/EXTENSION_POINTS.md`](./docs/developer/EXTENSION_POINTS.md) — your change does not silently modify a Stable surface without a semver bump.
- [ ] If you touched an actuator manifest or schema, you ran `pnpm tsx scripts/check_contract_semver.ts -- --rebaseline` and committed the updated baseline.
- [ ] If you touched a user-visible behavior, you added a `[Unreleased]` entry to `CHANGELOG.md`.
- [ ] Commit titles use Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:`, `breaking:`).

## What to work on

- Browse the [GitHub issue tracker](https://github.com/famaoai-creator/kyberion/issues), especially `good-first-issue` and `help-wanted`.
- Look at `docs/PRODUCTIZATION_ROADMAP.md` — pick a Phase task that's marked `not done`.
- Read `docs/developer/GOOD_FIRST_ISSUES.md` for starter slices that fit a 1-2 hour contribution.
- A starter slice should stay in one area, name one small file cluster, and include one validation command. If it needs broader coordination, file a normal roadmap issue instead of using `good-first-issue`.
- File an issue first if you're proposing a non-trivial change. We don't want you to spend a weekend on something we're about to redesign.

## Areas and CODEOWNERS

Each area has a designated CODEOWNER (see [`CODEOWNERS`](./CODEOWNERS) and [`MAINTAINERS.md`](./MAINTAINERS.md)). The CODEOWNER is auto-requested on PRs touching their area.

Major areas:

- Actuator framework (`libs/actuators/`, schemas).
- Mission lifecycle (`scripts/mission_controller.ts`, `scripts/refactor/mission-*`).
- Knowledge / governance (`knowledge/public/governance/`, tier-guard).
- Voice / surfaces (`presence/`, `satellites/voice-hub/`).
- Build / release / CI (`package.json`, `.github/workflows/`).

If your PR spans multiple areas, expect multiple reviewers.

## How to add a new actuator

See [`docs/developer/PLUGIN_AUTHORING.md`](./docs/developer/PLUGIN_AUTHORING.md) — a 30-minute walkthrough that covers manifest, schema, implementation, tests, and semver baseline.

## How to add Trace observability to an existing actuator

See [`docs/developer/TRACE_MIGRATION_TEMPLATE.md`](./docs/developer/TRACE_MIGRATION_TEMPLATE.md). The browser-actuator and mission_controller checkpoint are reference migrations; follow the same shape.

## How to add a vertical mission seed

See [`templates/verticals/README.md`](./templates/verticals/README.md). Each vertical is `README + mission-seed.json + pipeline.json`.

## Coding conventions

### File I/O

**Always** use `@agent/core/secure-io` (or its re-exports from `@agent/core`). Direct `node:fs` is rejected by the path-scope policy at runtime.

```typescript
import { safeReadFile, safeWriteFile, safeMkdir } from '@agent/core';
```

### Imports

ESM. Relative TS imports include `.js` extensions:

```typescript
import { foo } from './foo.js';        // ✅
import { foo } from '../foo';          // ❌ fails check:esm
```

Workspace package imports use the package name:

```typescript
import { logger } from '@agent/core';                       // ✅
import { foo } from '@agent/core/customer-resolver';        // ✅ — sub-export
import { logger } from '../../libs/core/index.js';          // ❌
```

See [`docs/PACKAGING_CONTRACT.md`](./docs/PACKAGING_CONTRACT.md) for the full ESM discipline.

### Errors

Classify errors before logging or surfacing:

```typescript
import { classifyError, formatClassification } from '@agent/core';

try { ... }
catch (err) {
  const c = classifyError(err);
  logger.error(formatClassification(c));
  // c.category, c.remediation, c.detail are available for structured handling
}
```

If you observe a real-world error that the classifier returns `'unknown'` for, add a rule in `libs/core/error-classifier.ts` (with a test).

### Tests

- Unit tests live next to source as `<file>.test.ts`.
- Integration tests live in `tests/`.
- Run with `pnpm vitest run <path>`.
- For tests that touch tier-guarded paths, set `KYBERION_PERSONA=ecosystem_architect` and `MISSION_ROLE=mission_controller` in `beforeEach`.

### Documentation

- User-facing changes: update `docs/user/` or `docs/QUICKSTART.md`.
- Operator-facing changes: update `docs/operator/`.
- Developer-facing changes: update `docs/developer/`.
- The README is for new visitors; only change it for major direction shifts.

Per `docs/DOCUMENTATION_LOCALIZATION_POLICY.md`, README / Quickstart / WHY are kept in **both English and Japanese**. PRs that change one language must also update the other (or open a follow-up issue).

### Comments

Default to no comments. Add a comment only when the *why* is non-obvious — a hidden constraint, a workaround for a specific bug, or behavior that would surprise a future reader.

## Conventional Commits

| Type | Meaning | Bump |
|---|---|---|
| `feat:` | New feature | minor |
| `fix:` | Bug fix | patch |
| `perf:` | Performance improvement (no behavior change) | patch |
| `refactor:` | Internal restructure (no behavior change) | patch |
| `docs:` | Documentation only | none |
| `test:` | Tests only | none |
| `build:` / `ci:` / `chore:` | Tooling / dependencies | none |
| Any with `!` after type or `BREAKING CHANGE:` footer | Breaking | major |

Examples:

```
feat(voice): add native-tts wrapper for OS-level TTS
fix(mission): close TOCTOU race in resumeMission
refactor(secure-io): consolidate path-scope checks
docs(quickstart): note KYBERION_REASONING_BACKEND=stub for offline trial
breaking(adf)!: remove deprecated step.target field
```

The PR title is what shows up in `CHANGELOG.md` after `pnpm tsx scripts/generate_changelog.ts --prepend`.

## Code review

- We aim to first-respond within 7 days. Pre-1.0, this slips sometimes. Ping if it does.
- Reviews focus on: correctness, clarity, alignment with stable contracts, test coverage. Style nits are auto-formatted by Prettier — don't litigate them.
- A reviewer's `Request changes` is binding only on the area they're CODEOWNER for. Cross-area objections are advisory unless escalated per [`GOVERNANCE.md`](./GOVERNANCE.md).

## Security

If you find a security issue, **do not** open a public issue. Follow [`SECURITY.md`](./SECURITY.md).

## Code of Conduct

Participation requires adherence to [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Governance

See [`GOVERNANCE.md`](./GOVERNANCE.md) for how decisions are made. See [`MAINTAINERS.md`](./MAINTAINERS.md) for who reviews what.

## Want to maintain Kyberion?

The path is in `MAINTAINERS.md`. Briefly: do good triage and PR work for a few months, get nominated.

---

Thanks for contributing.
