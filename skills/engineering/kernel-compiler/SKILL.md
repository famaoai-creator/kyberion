---
name: kernel-compiler
description: Output file path
status: implemented
arguments: 
- name: out
short: o
type: string
required: false
category: Engineering
last_updated: '2026-02-28'
tags: gemini-skill
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
