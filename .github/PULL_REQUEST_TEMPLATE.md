<!-- Thank you for contributing to Kyberion! -->

## Summary

<!-- 1–3 sentences. What changed and why. -->

## Coordination

<!-- Fill these in when the change is part of a mission/workitem flow. -->

- Mission ID:
- Workitem IDs:
- Evidence paths:
- Trace IDs:
- Related workflow doc:

## Type

<!-- Pick one or more. -->

- [ ] feat — new feature
- [ ] fix — bug fix
- [ ] docs — documentation only
- [ ] refactor — no observable behavior change
- [ ] test — tests only
- [ ] chore / build / ci — tooling
- [ ] breaking — breaking change (also check the `breaking` box and explain in §Migration below)

## Area

<!-- Which area(s) of the codebase? Multiple OK. See CODEOWNERS. -->

- [ ] actuator framework
- [ ] mission lifecycle
- [ ] knowledge / governance
- [ ] voice / surfaces
- [ ] build / release / CI
- [ ] docs

## Test plan

<!-- How did you verify? List concrete commands run. -->

```bash
# e.g.
pnpm vitest run libs/core/foo.test.ts
pnpm doctor
```

## Migration (breaking changes only)

<!-- If this is a breaking change, describe what users need to do. Required for `breaking:` PRs. -->

N/A.

## Stable surfaces

<!-- Did this change touch a stable surface (per docs/developer/EXTENSION_POINTS.md)? -->

- [ ] Touched a stable surface — version bumped + `pnpm tsx scripts/check_contract_semver.ts -- --rebaseline` run
- [ ] Did not touch a stable surface

## Checklist

- [ ] Mission / workitem references are included when applicable
- [ ] Evidence paths or trace IDs are included when applicable
- [ ] `pnpm validate` is green locally
- [ ] Tests added (or existing tests updated)
- [ ] CHANGELOG.md updated under `[Unreleased]` (for user-visible changes)
- [ ] PR title and commit titles follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] Read [`docs/developer/EXTENSION_POINTS.md`](../docs/developer/EXTENSION_POINTS.md) if touching public surfaces

## Governed data / snapshots (check when `knowledge/` or governance JSON changed)

<!-- Contract tests compare directories against committed snapshots; changing one side without the other breaks tests/ for everyone. -->

- [ ] `pnpm generate:knowledge-index && pnpm check:catalogs` is green (index/manifest regenerated)
- [ ] Actuator manifests changed → `pnpm sync:component-inventory` run (CAPABILITIES_GUIDE / global_actuator_index)
- [ ] `agent-profiles/` changed → `agent-profile-index.json` regenerated to match
- [ ] `surfaces/*.json` changed → `active-surfaces.json` snapshot matches (aggregate of per-surface files)
- [ ] `service-endpoints.json` changed → matching per-service file exists under `service-endpoints/`
- [ ] Snapshot contract tests pass: `pnpm vitest run tests/`

## Hygiene

- [ ] No compiled `.js` / `.d.ts` staged next to `.ts` sources (pre-commit hook enforces; build output belongs in `dist/`)
- [ ] `docs/improvement-plans-2026-07/` plan touched → its 実装状況 section and `docs/ROADMAP_COMPLETION_LEDGER.md` updated
- [ ] Template fixtures (`knowledge/product/scaffolds/`) use `__VAR__` placeholders — never `{{VAR}}` (formatters mangle it)

## Issue link

<!-- e.g., closes #123 -->
