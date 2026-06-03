---
title: Benchmark-Driven Harness Evolution
category: Architecture
tags: [architecture, harness, benchmark, experiment, replay]
importance: 9
author: Ecosystem Architect
last_updated: 2026-04-05
---

# Benchmark-Driven Harness Evolution

## Purpose

This document explains how Kyberion adopts the useful parts of the `autoagent` concept without collapsing Kyberion into a single-file harness optimizer.

The retained idea is simple:

- do not treat agent improvement as an ad hoc coding task
- treat it as a governed experiment loop
- keep only changes that improve replayable outcomes under an explicit metric

## Concepts Worth Adopting

### 1. Program the Improvement Loop

The human should describe:

- the target harness
- the protected boundary
- the evaluation corpus
- the success metric

Kyberion should then compile that into an experiment contract.

### 2. Baseline First

No retained harness change should exist without:

- a baseline run
- a rerun after the change
- a comparable score or pass-rate delta

### 3. One General Improvement Per Experiment

The unit of change should be:

- one failure cluster
- one general harness improvement
- one rerun
- one keep or discard decision

This prevents bundled edits from hiding regressions.

### 4. Protected Adapter Boundary

Some parts of a harness are policy and orchestration.
Other parts are integration glue.

Kyberion should model this explicitly as:

- editable reasoning surface
- fixed adapter boundary

That boundary should be part of the contract, not tribal knowledge.

### 5. Experiment Ledger

Each run should preserve:

- baseline identifier
- changed files or protected region
- measured delta
- keep or discard decision
- replayable evidence refs

Discarded runs still matter because they reveal failure classes.

## Concepts Not Adopted Directly

### Single-File Harness

`autoagent` uses a single-file harness for speed of iteration.
Kyberion should not copy that.

Kyberion needs:

- clear architectural boundaries
- actuator isolation
- knowledge-owned contracts
- multi-surface governance

### Benchmark-Only Worldview

Some Kyberion work is evaluated by:

- approval
- artifact quality
- incident avoidance
- reproducibility
- mission governance

Benchmark score is important, but it is not the only success signal.

## Kyberion Mapping

The concept maps into Kyberion as:

`intent -> experiment brief -> protected boundary -> benchmark run -> delta analysis -> keep/discard report`

Responsibility split:

- LLM
  - cluster failures
  - propose one general improvement
  - summarize the experiment
- Knowledge
  - define the benchmark policy
  - define protected boundaries
  - define keep or discard rules
- Compiler
  - bind the target harness
  - compile the experiment contract
  - prepare replay paths and comparison fields
- Executor
  - run the benchmark
  - persist results
  - attach evidence and trajectories

## Product Consequence

This model strengthens the earlier Kyberion direction:

- let humans start from natural language
- let the system compile the work into a governed contract
- make the result replayable

For harness evolution, that means the operator should be able to say:

`Improve this agent harness against the benchmark and keep only general wins.`

Kyberion should then produce a governed experiment path instead of immediately emitting raw actuator steps.
