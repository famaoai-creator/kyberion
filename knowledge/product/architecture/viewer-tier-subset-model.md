---
title: Viewer tier subset safety model
tags: [formal-methods, verification, authorization, viewer-scope, tiers, monotonicity]
last_updated: 2026-11-08
---

# Viewer tier subset safety model

## Explicit caps are authoritative

Viewer-tier narrowing receives an already resolved server-side authority set.
It may select a member of that set; it must never add a tier. An explicit empty
set means no tier access. Defaults belong to upstream role/credential resolution,
where omitted input and explicit empty input are different cases.

The previous `narrowSurfaceViewerTier` fallback treated `[]` like an omitted
configuration and restored role defaults. A direct source reproduction admitted
public/confidential for an empty readonly cap and all three tiers for an empty
localadmin cap. The Concierge `strictViewerTier` caller preserved `[]` but reached
this fallback. This establishes a narrowing-boundary inconsistency, not a claim
of a remotely reachable exploit.

The boundary now checks membership in the supplied array directly. Empty arrays
deny all requests; missing/null runtime values fail closed through the existing
403 error channel. Nonempty resolved caps retain their behavior. The upstream
resolver remains responsible for applying role policy and defaults, including
the operations console's personal-tier masking.

## Independent finite model

Following the [executable safety model pattern](./executable-safety-models.md),
`libs/core/surface/surface-viewer-tier.model.test.ts` defines a bit-set membership
oracle independently of production policy helpers. Two roles, all eight subsets
of public/confidential/personal and all three requested tiers give 48 states.
The 72 transitions remove one grant at a time. Every state must agree with
membership in its explicit cap.

The suite also checks:

- All 48 role/cap/request combinations against production narrowing.
- All 162 subset comparisons: removing grants cannot turn a denial into access.
- All 16 role/cap combinations at upstream resolution, separately from narrowing.
- A mutation restoring the empty-cap/default fallback, which must fail after all
  grants have been removed.
- Missing/null cap refusal and the real Concierge caller's explicit-empty,
  omitted-default and nonempty-cap behavior.

```bash
KYBERION_TEST_LEAK_STRICT=1 CI=true LANG=C.UTF-8 pnpm exec vitest run libs/core/surface/surface-viewer-tier.model.test.ts libs/core/surface/surface-mutation-guard.test.ts presence/displays/concierge/src/lib/ops/ops-viewer.test.ts
```

Run this from the repository root with the canonical Vitest configuration, which
resolves relocated core subpaths for the actual caller. A zero-file selection is
not validation.

## Assurance boundary

This exhausts the finite role/tier/subset abstraction for this narrowing function.
It does not prove credential authenticity, tenant/custody/audience enforcement,
route-wide noninterference or all malformed JavaScript objects. Those boundaries
retain their separate guards and tests. Client-supplied tenant/tier values remain
selectors inside a server-resolved viewer scope, never authorization sources.
