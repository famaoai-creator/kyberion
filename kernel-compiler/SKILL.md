---
name: kernel-compiler
description: Compiles core utilities into standalone binaries (Go/Rust) to reduce runtime dependencies. Ensures the ecosystem's "Self-Bootstrapping" capability.
---

# Kernel Compiler

This skill prepares the ecosystem for a dependency-free future.

## Capabilities

### 1. Core Logic Compilation
- Translates `scripts/lib/core.cjs` logic into Go or Rust.
- Builds static binaries for Linux/macOS/Windows.

### 2. Self-Bootstrapping
- Generates a "Zero-Dependency Installer" that can revive the agent on a fresh machine without Node.js or Python pre-installed.

## Usage
- "Compile the Shared Utility Core into a Linux binary."
- "Generate a self-contained installer for the entire skill suite."

## Knowledge Protocol
- Adheres to `knowledge/orchestration/polyglot-roadmap.md`.
