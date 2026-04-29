---
title: Wisdom Policy Adapter Guide
category: Governance
tags: [llm, policy, adapter, distillation, governance]
importance: 7
author: Ecosystem Architect
last_updated: 2026-04-30
---

# Wisdom Policy Adapter Guide

This guide explains how Kyberion selects and runs reasoning backends for mission distillation and related knowledge operations.

## Core Rule

`wisdom-policy.json` is the source of truth for which profile is used for each purpose.

- `purpose_map` decides which profile name a purpose should try first
- `profiles.<name>.command` declares the executable
- `profiles.<name>.adapter` selects the runtime adapter
- `profiles.<name>.args` and `timeout_ms` are passed through to the runner

The executor does not need provider-specific branching when the policy is complete.

## Adapter Contract

Use `adapter` to describe how the profile is executed.

Examples:

- `shell-json` for a shell command that emits JSON
- `codex-cli` for the Codex structured query helper
- `gemini-cli` for the Gemini structured query helper
- a future `local-llm-*` adapter for an MLX, Ollama, or other local runner

If `adapter` is omitted, the runtime falls back to `shell-json`.

## Adding A New Local LLM

1. Add a new profile under `llm.profiles` in [`wisdom-policy.json`](./wisdom-policy.json).
2. Set `command`, `args`, `timeout_ms`, and `adapter` for that runner.
3. If the adapter is new, register a structured runner in `scripts/refactor/mission-llm.ts`.
4. Add or update tests that prove the new adapter can execute a structured schema.
5. Run build and the reasoning tests before relying on the new profile in distillation.

## Operational Notes

- Keep `distill` routed through a high-confidence profile.
- Use `stub` only for deterministic offline or test runs.
- Prefer adapter additions over provider-specific branching in mission scripts.
- Keep user-facing explanations policy-first: avoid naming a specific CLI unless it matters to the operator.

