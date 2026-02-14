# Polyglot Core Transformation Roadmap (Sidecar Architecture)

To support Python, Go, and Rust skills natively without Node.js dependencies, we will transition the Shared Utility Core to a Sidecar model.

## Phase 1: Current State (Node.js Monolith)

- **Core**: `scripts/lib/core.cjs`
- **Constraint**: All skills must be wrapped in or invoke Node.js.

## Phase 2: The Sidecar Bridge (Transition)

- **Architecture**: Create a compiled binary (Go/Rust) `gemini-core` that exposes:
  - `gemini-core log --level info "msg"`
  - `gemini-core file read <path>`
- **Integration**: Update `core.cjs` to simply wrap calls to this binary.

## Phase 3: True Polyglot (Final State)

- **Native Bindings**: Provide `gemini-core-py`, `gemini-core-rs` libraries that talk to the Sidecar process via gRPC or standard I/O.
- **Decoupling**: Skills become standalone binaries communicating only with the Sidecar.
