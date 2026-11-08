---
title: Executable safety models for orchestration
tags: [formal-methods, verification, adf, testing, safety]
last_updated: 2026-11-08
---

# Executable safety models for orchestration

## Decision and sources

Start with ADF lifecycle safety: executing an unvalidated contract is a high-value
failure to prevent, and the orchestration graph is small enough to enumerate.
Keep the existing production runner and independently specify its expected
behavior in tests.

The [Cedar verification-guided development paper](https://arxiv.org/abs/2407.01688)
combines executable formal models, mechanized proofs, differential randomized
testing against production, and property-based testing. The
[cedar-spec repository](https://github.com/cedar-policy/cedar-spec) implements that
approach with Lean and Rust. Kyberion adopts the executable-model and differential
checking ideas here; it does **not** inherit Cedar's mechanized proofs.

[TLC](https://github.com/tlaplus/tlaplus) is an established explicit-state model
checker for TLA+. Its state-space exploration approach motivates exhaustive
checking of a small finite graph. This implementation is a TypeScript safety
checker, not TLC, TLA+ support, SMT solving, or a theorem prover. It adds no runtime
dependency or external service.

Other candidate applications are writer-lease fencing and viewer-scope policy
equivalence. Those need separate models of time, concurrent actors, or scoped
authorization inputs; this ADF model establishes no guarantees about them.

## Implementation and acceptance

`libs/core/testing/finite-state-checker.ts` explores reachable states breadth first
and evaluates every named safety invariant. Results are:

- `verified`: exploration exhausted the supplied graph and found no violation.
- `violated`: an invariant failed; the result names it and includes a shortest
  counterexample from an initial state.
- `inconclusive`: the state budget prevented complete exploration. This must
  never be accepted as verification.

State keys must preserve all facts affecting invariants and transitions. State
objects must be immutable during exploration, predicates and successor functions
must be deterministic, and successor lists must be finite. An incorrect model,
predicate, or key can conceal a real defect. Exceptions propagate as errors.
The `visited` count is the number of discovered unique states, including queued
states; it is not the number of states whose predicates have already run.

`libs/core/pipeline/adf-lifecycle.model.test.ts` independently models hook outcomes,
repair availability, call histories and successful phases. It exhausts 26 states
and 24 transitions, checking:

- Execute requires a successful commit.
- Commit requires successful initial validation or repaired revalidation.
- Revalidation requires successful repair.
- Repair is attempted at most once.
- Failed repair or revalidation prevents commit.
- A successful result requires successful execution.

It also checks 256 production runs: all 64 assignments of six binary hook
outcomes, with repair available/unavailable and synchronous/asynchronous hooks.
Assignments include unreachable outcomes. Comparisons cover call order, object
identity at handoffs, original error identity, returned value and completed-phase
records. A deliberately broken validation-bypass model must produce a
counterexample, so checking a trivially accepting invariant is not enough.

Run the checker tests and conformance suite with:

```bash
pnpm exec vitest run libs/core/testing/finite-state-checker.test.ts libs/core/pipeline/adf-lifecycle.model.test.ts libs/core/pipeline/adf-lifecycle.test.ts
```

## Assurance boundary

This is exhaustive safety checking **of the supplied finite abstraction**, plus
deterministic model-based conformance testing of the production runner. It is not
a proof of all TypeScript executions. Hook correctness, malicious hooks, shared
mutable data, process crashes, nonterminating promises, concurrent side effects,
and external systems are outside the model. No liveness or fairness property is
checked. Asynchronous tests exercise resolved/rejected promises; they do not
enumerate arbitrary event-loop schedules. Production behavior is unchanged.

For another orchestration model, first state the safety property and abstraction,
keep the specification independent of implementation, include a negative control,
and document the explored scope. Use a dedicated established verifier when the
state space or required logic exceeds this small safety-checking mechanism.
