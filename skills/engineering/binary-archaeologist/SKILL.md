---
name: binary-archaeologist
description: Output path for forensic report
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

# Binary Archaeologist

This skill shines a light into the "dark corners" of your system where source code is missing.

## Capabilities

### 1. Reverse Engineering Support

- Analyzes compiled binaries and libraries to map their function calls and data structures.
- Identifies security risks and hidden dependencies in legacy "black boxes."

### 2. Wrapper Generation

- Generates modern API wrappers or documentation for legacy executables to make them safe to use in new microservices.

## Usage

- "Analyze this legacy `engine.bin` file and document its input/output parameters."
- "Reverse engineer the logic of this third-party library to check for hidden telemetry."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
