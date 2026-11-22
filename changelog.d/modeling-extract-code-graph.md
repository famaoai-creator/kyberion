---
category: Added
---

- **`modeling:extract_code_graph` op** — builds the reverse_spec coverage denominator (modules, entrypoints, boundaries, import edges) with web-tree-sitter for TypeScript/TSX, JavaScript, Python, Java, Scala, C#, PHP, Rust, Go, Ruby, C and C++. Each node kind is counted by two independent routes (AST marker queries and line patterns) and reconciled with an element-level difference; the denominator is their union. Rules are governed data in `code-graph-enumeration-rules.json`. The `reverse-spec-code-graph` pipeline template writes `evidence/code-graph.json` for the `code_graph` phase.
- Grammar packages ship prebuilt WASM; their native addons are never built (`allowBuilds: false`, recorded in the install-script allowlist).
