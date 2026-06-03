# Provider CLI Capability Discovery

## Purpose

Kyberion should discover provider-native CLI features before it tries to use them, then register the discovered features in governed capability registries.

This prevents the system from hard-coding assumptions about what Codex, Gemini, GitHub CLI, or future provider CLIs can do.

The current implementation splits that responsibility into:

- `harness-capability-registry.json` for the canonical capability inventory
- `provider-capability-scan-policy.json` for provider probe definitions
- `provider-capability-scanner` for shared discovery logic
- `harness-adapter-registry.json` for execution contracts

## Discovery Inputs

The discovery layer should inspect:

- `codex --help`
- `codex app-server --help`
- `gemini --help`
- selected `gemini <subcommand> --help` commands
- `gh --help`
- selected `gh <subcommand> --help` commands

Only commands that are actually present on the host should be registered.

## What Gets Registered

The registry should capture:

- capability identity
- provider
- command or subcommand
- risk class
- replayability
- fallback path
- whether the capability is active or experimental

The goal is not to encode every help line.
The goal is to register the stable, operationally useful surface area.

## Current Coverage

### Codex

Observed and worth registering:

- `exec`
- `review`
- `app-server` or codex app session control
- `cloud`
- `plugin`
- `mcp`
- `features`

### Gemini

Observed and worth registering:

- `-p / --prompt`
- `extensions`
- `skills`
- `hooks`
- `mcp`
- `--acp`

### GitHub CLI

Observed and worth registering:

- `pr`
- `issue`
- `repo`
- `api`
- `run`
- `workflow`
- `skill`
- `agent-task`

## Governance Rule

Do not treat discovery output as final truth by itself.

Discovery should feed:

1. the harness capability registry
2. the adapter registry
3. execution receipts and traces

That gives Kyberion a stable audit trail while still allowing provider features to evolve.
