---
title: Lockfile change review — web-tree-sitter and grammar packages for code-graph extraction
tags: [improvement-plan, 2026-11, lockfile]
last_updated: 2026-11-23
status: completed
---

# Lockfile change review — web-tree-sitter and grammar packages

- **Date**: 2026-11-23
- **Change**: adds `web-tree-sitter@0.27.2` and the official tree-sitter grammar packages `tree-sitter-{c@0.24.1, c-sharp@0.24.0, cpp@0.23.4, go@0.25.0, java@0.23.5, javascript@0.25.0, php@0.24.2, python@0.25.0, ruby@0.23.1, rust@0.24.0, scala@0.24.0, typescript@0.23.2}` as exact pins in the root `package.json` (compiled actuators resolve from the repository root) and in `@actuator/modeling`.
- **Purpose**: `modeling:extract_code_graph` (mission MSN-REVERSE-SPEC-20261123) parses legacy source to build the reverse_spec coverage denominator. Each grammar package ships a prebuilt `.wasm`; it is read through secure-io and loaded by web-tree-sitter, so no native code runs.
- **Lockfile diff reviewed**: 279 added lines, 0 removed. New entries are the packages above, their transitive grammar dependencies `tree-sitter-c@0.23.6` (via cpp) and `tree-sitter-javascript@0.23.1` (via typescript), and `node-addon-api@8.9.2` / `node-gyp-build@4.8.4` (declared dependencies of the grammars' optional native bindings). No existing package version changed.
- **Install scripts**: every grammar declares `install: node-gyp-build`. All twelve names are `allowBuilds: false` in `pnpm-workspace.yaml` with reasons in `knowledge/product/governance/install-script-allowlist.json`; the native addon is never built. `web-tree-sitter` has no install script.
- **Licenses**: all MIT.
- **Release age**: every version is older than the workspace `minimumReleaseAge` (1440 minutes); the newest, `web-tree-sitter@0.27.2`, was published 2026-11-07.
- **Lockfile digest**: `pnpm-lock.yaml` sha256: 42162e039fb0096658bb2bf87a1499321542505c69d3fe364366fce4cec8b455
- **Accepted invocation**: `PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-11/LOCKFILE_CHANGE_CODE_GRAPH_2026-11-23.md pnpm check -- --scope pr`.
