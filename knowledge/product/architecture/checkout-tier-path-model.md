---
title: Checkout relocation tier safety model
tags: [formal-methods, verification, security, tiers, paths]
last_updated: 2026-11-08
---

# Checkout relocation tier safety model

A resource's logical repository address determines its data tier. Moving the
checkout underneath a public scratch directory must not turn its confidential
knowledge into public data. Previously `detectTier` inspected absolute path
markers, so an outer storage floor could shadow an inner knowledge partition.
Broad affected tests in a nested worktree exposed this existing defect.

The classifier now uses the existing `policyRelativePath` authority mapping
before applying its existing tier rules. Primary-checkout authority stores keep
their mapping; genuinely external paths retain absolute classification with
normalized separators. Storage layouts and tier precedence are unchanged.

`libs/core/tier-guard.path-model.test.ts` declares expected inner partitions
independently of production parsers. Its finite relocation model covers 33
addresses across 13 ancestor layouts: 429 states and 396 relocation transitions.
The production comparison checks all 429 cases. A negative control that trusts
ancestor markers violates relocation invariance. Additional cases preserve
outside-root and primary-authority behavior.

Run the path model with the tier-guard suites, `op-preflight-stages.test.ts`,
`tenant-store-guard-gaps.test.ts` and `tiered-mission.test.ts`. Build first for
tests that exercise compiled core modules. This finite model verifies the
declared address families, not every filesystem spelling, symlink resolution,
tenant authorization or resource-policy decision; those retain separate guards.
