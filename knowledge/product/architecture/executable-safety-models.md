---
title: Executable safety models for orchestration
tags: [formal-methods, verification, adf, lease, concurrency, testing, safety]
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

Writer-lease token arithmetic, clock validation and viewer-scope policy
equivalence need separate models. The backend exclusion increment below does not
establish guarantees about those properties or real distributed adapters.

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

## Lease backend exclusion increment

[Kleppmann's distributed-locking analysis](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
explains how a paused client can resume after its lease expires and why the
protected resource must enforce fencing. The
[Chubby paper](https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/)
provides background on reliable coarse-grained locking. These motivate checking
exclusion and stale-client behavior separately rather than treating a timeout as
proof that execution has stopped.

Kyberion's backend contract holds a namespace mutex through the entire callback.
A deterministic reproduction found that the memory provider's separate async
queue and sync-held set allowed a sync callback into an active async namespace.
At the writer-lease layer, this could admit another writer after the first lease's
TTL elapsed while its callback still ran. Sync admission now refuses a namespace
with queued or active async ownership. Different namespaces remain independent.

Memory and KV-stub providers also retained queue tails because cleanup compared
different Promise identities. A rejected callback could leave an unhandled
rejected cleanup tail. Private tails now always settle successfully and remove
only their own final reservation; the returned callback Promise still preserves
its value or original error. The KV provider remains a contract stub, with sync
locking unsupported.

`libs/core/lease/lease-backend.model.test.ts` specifies two one-shot async callers
and atomic sync probes independently of the implementation. It exhausts 10 states
and 28 transitions, including callback success/failure and FIFO handoff, and
compares the real memory provider against all 372 valid schedules of up to five
actions. The model checks single async ownership, active/queue identity
consistency and absence of sync/async overlap. A mutation permitting conflicting
sync entry must yield a shortest counterexample.

The model's enqueue and settle actions include the Promise-microtask handoff;
they do not enumerate every microtask scheduling point. Separate regressions in
`lease-backend-exclusion.test.ts` exercise pending admission, active callbacks,
expired-writer overlap, independent namespaces, sync re-entry, callback rejection,
queue cleanup and shared KV successors. A fake clock checks KV acquisition delay
after predecessor failure without real-time sleeps.

```bash
KYBERION_TEST_LEAK_STRICT=1 CI=true LANG=C.UTF-8 pnpm exec vitest run libs/core/lease/lease-backend.model.test.ts libs/core/lease/lease-backend-exclusion.test.ts libs/core/lease/lease-backend.test.ts libs/core/lease/writer-lease.test.ts
```

The guarantee is scoped to the memory provider's one-runtime exclusion contract
and the tested KV-stub queue behavior. It is not distributed consensus, durable
fencing-token verification, crash recovery, arbitrary runtime scheduling or a
liveness proof. Callbacks that await a new lock on their own namespace are not
supported. Synchronous callbacks must return synchronously.

## Assurance boundary

This is exhaustive safety checking **of the supplied finite abstraction**, plus
deterministic model-based conformance testing of the production runner. It is not
a proof of all TypeScript executions. Hook correctness, malicious hooks, shared
mutable data, process crashes, nonterminating promises, concurrent side effects,
and external systems are outside the model. No liveness or fairness property is
checked. Asynchronous tests exercise resolved/rejected promises; they do not
enumerate arbitrary event-loop schedules. The ADF runner is unchanged; the lease
increment changes conflicting admission and queue-failure cleanup as described
above.

For another orchestration model, first state the safety property and abstraction,
keep the specification independent of implementation, include a negative control,
and document the explored scope. Use a dedicated established verifier when the
state space or required logic exceeds this small safety-checking mechanism.
