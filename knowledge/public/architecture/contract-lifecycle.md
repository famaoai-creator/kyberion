---
title: Contract Lifecycle
category: Architecture
tags: [architecture, adf, compiler, validation, execution]
importance: 10
author: Ecosystem Architect
last_updated: 2026-04-05
---

# Contract Lifecycle

## 1. Problem

Kyberion often fails not because intent resolution is wrong, but because a low-level executable contract is produced too early and sent directly to actuators.

The failure pattern is:

- natural language request
- immediate ADF generation
- execution-time failure
- retry by regenerating another raw contract

This wastes turns and makes failures feel arbitrary.

## 2. Rule

Executable contracts must not be treated as the first artifact.

The correct lifecycle is:

```text
conversation
-> semantic brief
-> draft contract
-> preflight validation
-> auto-repair if safe
-> committed executable contract
-> execution
-> evidence / replay
```

## 3. Responsibilities

### LLM

Allowed:

- normalize intent
- fill semantic briefs
- draft content
- explain missing inputs

Forbidden:

- invent low-level executable details when a compiler can produce them
- bypass preflight
- declare a broken draft executable

### Knowledge

Owns:

- process design
- document profile and sections
- outcome definitions
- runtime boundaries
- repair policy

### Compiler

Owns:

- semantic brief to contract compilation
- path preparation
- alias normalization
- safe contract repair
- preflight classification

### Executor

Owns:

- actuator invocation
- evidence persistence
- replayable output records

## 4. Preflight States

Preflight should classify a contract as:

- `ready`
- `needs_clarification`
- `invalid`

`needs_clarification` means execution can proceed only after safe repair or additional input.

`invalid` means the contract must not execute.

## 5. Auto-Repair Policy

Auto-repair is allowed only for deterministic, semantics-preserving fixes such as:

- inferring `action: "pipeline"` from a `steps` array
- adding empty `context` for a pipeline wrapper
- adding empty `params` for direct actuator actions
- normalizing missing or non-`.json` output paths

Auto-repair is not allowed for:

- guessing missing business inputs
- inventing unresolved variables
- changing the requested outcome
- overriding governance or authority requirements

## 6. Current Runtime Application

`orchestrator-actuator` now preflights execution plan sets before write or run.

It detects:

- unresolved `{{template_variables}}`
- missing or invalid action fields
- invalid nested pipeline contracts

It repairs safe structural issues before execution.

## 7. Why This Matters

Kyberion should not ask users to write perfect ADF from the beginning.

The system should let users solve problems conversationally first, then compile the decision into a replayable and governed contract.

ADF is therefore:

- not the starting language for humans
- but the committed execution language for the system
