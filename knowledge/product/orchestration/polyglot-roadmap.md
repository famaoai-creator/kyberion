---
title: Polyglot Core Transformation Roadmap (Sidecar Architecture)
category: Orchestration
tags: [orchestration, polyglot, roadmap]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Polyglot Core Transformation Roadmap (Sidecar Architecture)

> **注記（2026-10 確認）**: 本文書は 2026-03 時点の構想メモであり、現状を反映していません。`scripts/lib/` は現在すべて TypeScript（`scripts/lib/*.ts`）で、`scripts/lib/core.js` や `gemini-core` バイナリは存在しません。sidecar 方式は採用されておらず、共有ユーティリティの正本は `@agent/core`（`libs/core/foundation/` 等、`docs/developer/EXTENSION_POINTS.md` §8 参照）です。履歴として保持しています。

To support Python, Go, and Rust skills natively without Node.js dependencies, we will transition the Shared Utility Core to a Sidecar model.

## Phase 1: Current State (Node.js Monolith)

- **Core**: `scripts/lib/core.js`
- **Constraint**: All skills must be wrapped in or invoke Node.js.

## Phase 2: The Sidecar Bridge (Transition)

- **Architecture**: Create a compiled binary (Go/Rust) `gemini-core` that exposes:
  - `gemini-core log --level info "msg"`
  - `gemini-core file read <path>`
- **Integration**: Update `core.js` to simply wrap calls to this binary.

## Phase 3: True Polyglot (Final State)

- **Native Bindings**: Provide `gemini-core-py`, `gemini-core-rs` libraries that talk to the Sidecar process via gRPC or standard I/O.
- **Decoupling**: Skills become standalone binaries communicating only with the Sidecar.
