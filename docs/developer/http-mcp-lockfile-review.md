---
title: HTTP MCP resource-server lockfile review
last_updated: 2026-10-10
---

# Reviewed dependency declaration

The shared-network package now imports Express for its default-disabled HTTP
MCP router and declares `express: ^5.2.1` directly. The root package already
declared and resolved this exact version before the change.

Independent code review against frozen main `86c3266d7cba7f99858a5b5799b4cb4ee5f25d3d`
confirmed that `pnpm-lock.yaml` changes only by three
importer lines referencing the existing `5.2.1(supports-color@7.2.0)` resolution.
No package snapshot, integrity, version, SDK, or transitive resolution changes
are introduced by this PR; the merged main SimpleWebAuthn dependency graph is
preserved unchanged. The MCP SDK remains 1.31.0.

pnpm-lock.yaml sha256: 8ddde318a7de66f5685b858ff665f66777395d46eecc1436d65b0b048be40e48

shared-network/package.json sha256: ea2f46438683a0da7d02ab09ef5426a285d0e540e92d670568516c756042adb5

The repository-supported lockfile gate may use this file as
`PI_LOCKFILE_REVIEW_EVIDENCE`, with `PI_ALLOW_LOCKFILE_CHANGE=1`, for this exact
reviewed hash. A later lockfile change requires new review and evidence.
