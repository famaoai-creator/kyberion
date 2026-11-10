---
title: Distill Policy Adapter Guide
category: Governance
tags: [llm, policy, adapter, distillation, governance]
importance: 7
author: Ecosystem Architect
last_updated: 2026-11-10
---

# Distill Policy Adapter Guide

This guide explains how Kyberion selects and runs reasoning backends for mission distillation and related knowledge operations.

> The policy file was `wisdom-policy.json` and the override env var `KYBERION_WISDOM_LLM_PROFILE` until 2026-11 (Concept Model v2 D8: "wisdom" names the actuator only). Both old names are still read for one release with a deprecation warning; use `distill-policy.json` and `KYBERION_DISTILL_LLM_PROFILE`.

## Core Rule

`distill-policy.json` is the source of truth for which profile is used for each purpose.

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

1. Add a new profile under `llm.profiles` in [`distill-policy.json`](distill-policy.json).
2. Set `command`, `args`, `timeout_ms`, and `adapter` for that runner.
3. If the adapter is new, register a structured runner in `libs/core/mission/mission-llm.ts`.
4. Add or update tests that prove the new adapter can execute a structured schema.
5. Run build and the reasoning tests before relying on the new profile in distillation.

## Operational Notes

- Keep `distill` routed through a high-confidence profile.
- Mission distills stay in mission-local `evidence/distillation.md`; they are not published to `knowledge/product/evolution/` by default. Curated promotion requires explicit knowledge-domain classification; sensitivity tier is not a domain selector. For repository work, the curated product record is promoted into the PR branch before the PR is opened, so it ships with the code (see [review.md](./phases/review.md#product-lessons-ship-inside-the-code-pr)).
- Use `stub` only for deterministic offline or test runs.
- Prefer adapter additions over provider-specific branching in mission scripts.
- Keep user-facing explanations policy-first: avoid naming a specific CLI unless it matters to the operator.
