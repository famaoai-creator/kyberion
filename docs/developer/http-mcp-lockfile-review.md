---
title: HTTP MCP resource-server lockfile review
last_updated: 2026-10-10
---

# Reviewed dependency declaration

The shared-network package now imports Express for its default-disabled HTTP
MCP router and declares `express: ^5.2.1` directly. The root package already
declared and resolved this exact version before the change.

Independent code review confirmed that `pnpm-lock.yaml` changes only by three
importer lines referencing the existing `5.2.1(supports-color@7.2.0)` resolution.
No package snapshot, integrity, version, SDK, or transitive resolution changes
are included. The MCP SDK remains 1.31.0.

pnpm-lock.yaml sha256: bad4f0b114d3b2d3959d5353cfad0ef8f5ed64e6d92a30f1ba31cbcb9d2a2b17

shared-network/package.json sha256: ea2f46438683a0da7d02ab09ef5426a285d0e540e92d670568516c756042adb5

The repository-supported lockfile gate may use this file as
`PI_LOCKFILE_REVIEW_EVIDENCE`, with `PI_ALLOW_LOCKFILE_CHANGE=1`, for this exact
reviewed hash. A later lockfile change requires new review and evidence.
