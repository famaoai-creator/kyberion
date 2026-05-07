<!-- Thank you for contributing to Kyberion! -->

## Summary

<!-- 1–3 sentences. What changed and why. -->

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

- [ ] `pnpm validate` is green locally
- [ ] Tests added (or existing tests updated)
- [ ] CHANGELOG.md updated under `[Unreleased]` (for user-visible changes)
- [ ] Commit titles follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] Read [`docs/developer/EXTENSION_POINTS.md`](../docs/developer/EXTENSION_POINTS.md) if touching public surfaces

## Issue link

<!-- e.g., closes #123 -->
