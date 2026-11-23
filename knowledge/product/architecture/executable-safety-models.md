---
title: Executable safety models for orchestration
tags: [formal-methods, verification, adf, lease, concurrency, testing, safety]
last_updated: 2026-11-23
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

The follow-up models cover [writer fencing arithmetic and clocks](./writer-fencing-safety-model.md),
[explicit viewer tier caps](./viewer-tier-subset-model.md), and
[checkout-relative tier classification](./checkout-tier-path-model.md).
These boundaries are checked separately: backend exclusion alone does not
establish their guarantees or qualify real distributed adapters.

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

To read the real exploration counts while pinning a model (instead of
deliberately failing an assertion to see the diff), set `KYBERION_MODEL_STATS=1` —
each `checkFiniteStateSafety` call logs its result as one JSON line
(`status`, `visited`, `transitions`, and the violated invariant name when any):

```bash
KYBERION_MODEL_STATS=1 pnpm exec vitest run <model file>
```

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

## WorkItem completion after lease recovery

`libs/core/workforce/work-item-completion.model.test.ts` models one ordinary
WorkItem with up to two lease generations. It checks six reachable states and
ten transitions covering claim, expiry with reaping, reacquisition, completion,
and rejected stale or duplicate completion. A mutation accepting the first
ticket after reacquisition must produce the counterexample
`claim 1 → reap → claim 2 → complete 1`.

The test replays ten operation sequences through the public coordination APIs
for each of two configurations: two different holders and one holder acquiring
both lease generations. It checks item status and the active lease after each
operation. A rejected completion must preserve the item snapshot and its
coordination events. The clock advances deterministically to drive recovery.
Expiry and reaping form one model action. The explored sequences use one
process, one reaping step, and ordinary completion through `releaseWorkItem`.

```bash
pnpm exec vitest run libs/core/workforce/work-item-completion.model.test.ts
```

### Interrupted completion, competing processes, and effect ownership

The atomic coordination suite injects an interruption before each of the lease,
item, and event appends needed by completion. With attempt-bound completion
evidence supplied to the reaper, the item converges to `done` and reaping again
preserves the terminal snapshot. The suite also exits a child process before the
item append and recovers in a new process against the same store. A separate
two-process race starts a stale release and current release together and
requires exactly one durable `done` snapshot. It accepts either rejection code
for the stale release, depending on which process obtains the lock first.

The external-effect recovery model explores six reachable states and six
transitions for a single held target. It checks that reaping an interruption
without completion evidence cannot grant a replacement claim. Allowing that
claim produces a counterexample. The ownership integration suite checks the
two evidence outcomes through production APIs using a synthetic shared target
and an attempt-bound evidence callback. It checks that the old lease cannot
settle the effect. With evidence, reaping settles ownership and a different
WorkItem can claim the target. Without evidence, both the original and a
competing WorkItem remain fenced.

The subprocess tests use a shared local filesystem, and the interruptions are
at append boundaries. The effect test verifies Kyberion's admission and
settlement decisions with supplied evidence. Remote execution, provider-side
deduplication, filesystem durability after power loss, and progress guarantees
are outside this scope.

```bash
pnpm exec vitest run libs/core/workforce/work-item-completion.model.test.ts libs/core/workforce/work-coordination.atomic.test.ts libs/core/workforce/work-effect-ownership.integration.test.ts
```

## Event scope lineage

`libs/core/event/event-scope.lineage-model.test.ts` enumerates request
combinations for two authoritative scopes: a confidential session with a full
entity chain and a public standalone project. Each lineage field and the tier
can be omitted, repeat the authoritative value where present, or supply a
conflicting value. The independent expectation is that only inputs whose
supplied values agree with authority can resolve.

The suite compares 2,475 combinations against the scope APIs. For all 132
accepted inputs, it also checks that shared redaction, serialization, and
record parsing preserve the exact authorized scope and remove all three
identity and stance fields. Nine additional cases cover the compatibility
alias `tenant_id` and its agreement with `tenant_slug`. The model treats the
authority as already resolved and covers these representative values and
transforms. Authority lookup, trusted overrides, and storage or HTTP
authorization are separate boundaries.

```bash
pnpm exec vitest run libs/core/event/event-scope.lineage-model.test.ts
```

## Storage layout and artifact storage classes

`libs/core/storage/storage-layout.test.ts` models every registered floor
against ten representative custody partitions: system, and each of the
three data tiers combined with shared storage or either of two tenants. It
checks 40 distinct placements, relative and absolute classification, and
agreement of the tier resolvers. This is a lexical layout check. The existing
storage-layout and tier-path tests cover malformed segments, compatibility
paths, and runtime partition enumeration.

`libs/core/workforce/artifact-registry.test.ts` models the five artifact
`storage_class` values against ordinary registration and delivery
registration. The ten cases check the persisted class and locator, the class
query, and exclusion of temporary records. The registry rejects temporary
delivery without leaving a row. The matrix checks metadata and does not dereference
the locator or establish publication authority.

## Data-model coverage inventory

The store inventory starts at [store-catalog.json](../governance/store-catalog.json).
The domain tests below exercise distinct contracts within and across those
stores. Coverage is per named invariant.

| Model                                | Current executable coverage                                                                  | Open model boundary                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Placement and storage class          | Floor/custody matrix, artifact registry admission, tenant partition enumeration              | Cross-store publication and physical locator resolution                                |
| Tier and custody                     | Checkout tier-path and viewer tier-subset models, resource access and custody contract tests | Agreement across route, projection, storage and egress for a single request            |
| Entity lineage                       | Event scope lifecycle model, scope and mission ledger tests                                  | Historical scope migration followed by reparenting or offboarding                      |
| Work and execution authority         | ADF, lease, WorkItem completion and external effect models, process interruption tests       | Provider-side effect idempotency and distributed storage semantics                     |
| Retention, restore and offboarding   | Storage floor and event retention, scope offboarding, backup/restore integration tests       | Interleavings of restore, append, cleanup and offboarding across stores                |
| Durable decisions and audit evidence | Decision ledger conformance, approval partition, audit-chain tenant tests                    | Approval consumption, ledger append and replay as one protocol                         |
| Artifact provenance and delivery     | Artifact records, bundles and asset derivation tests                                         | Record, ownership, derivation and published reference consistency after partial writes |
| Delegation and replay                | Delegation idempotency and lease tests                                                       | Reservation, outcome persistence and retry after restart across executors              |

## Restore and first-publication interruption checks

The backup suite exercises a live append after the restore's initial check
using both a colliding filename and a separate file in the same partition.
The late check rejects installation and preserves the live files. Exclusive
creation also protects each ledger file between the late check and its write.
Live restore, executed offboarding, and the destructive janitor acquire the
same checkout maintenance lock without waiting. Their contention tests
verify that a competing invocation fails before it mutates the target.
Ordinary writers still require quiescence for multi-file installation.

The scoped artifact suite injects a failure at the scope index, ownership
append, and surface-record write. It checks that no new surface record exists
at each interruption boundary, and that a normal retry with the same artifact
ID publishes the body and its ownership locator. The test models first
publication. Replacement and retry also have independent integration checks.
Recovery of derivation receipts is outside that claim.

### Replacement and deletion counterexamples

`libs/core/storage/storage-lifecycle.model.test.ts` explores two bounded
protocols. The restore model represents one file in one partition. A file
created by a live writer blocks installation. A completed offboarding between
preflight and placement leaves the path empty and allows the restore to bring
back archived bytes. Comparing a deletion generation at the installation
boundary prevents this trace in the model. The implementation prevents the
overlapping commands from running together through the shared maintenance
lock. An explicitly started later restore has its own admission decision.

The publication model starts with a visible version, permits one interruption
and retry, and checks the version reached through the visible reference and
the number of appends for the new version. Replacing bytes at the same path
breaks the reference invariant before the new record is published. A distinct
path preserves the current version. The artifact-store integration suite
uses the same logical name across an ownership-write failure and retry and
verifies the old bytes remain readable. The model reports duplicate appends
after interruption without idempotent replay. Production indexes a path
and digest once and avoids repeating the latest unchanged ownership
snapshot when the caller supplies a stable artifact ID.

Further conformance tests exercise the write boundaries around those
protocols. A foreign publication ID and contradictory organization are
rejected before any scoped body or index is created, including after a
first publication stops with only an ownership row. Scoped and governed
rewrite and append calls preserve the bytes of a published session artifact.
The backup suite restores an allowed directory with a withheld descendant
and verifies the existing live file at that descendant remains untouched.

## External data transfer and reconciliation

Ingest tests interrupt a cursor update after a source listing and recover
its persisted batch without invoking the transport. Cursor commits compare
the watermark used for the walk, and a cursor pointing at missing batch data
fails closed. The persisted batch is a work list, with downstream landing
and its own deduplication remaining a separate operation.

External mutation reservations remain immutable and block reuse of the same
invocation. A separate scoped outcome record carries the classified result
and an optional provider receipt identifier. A trusted connector can use
`reconcileExternalOperation` with a read-only lookup and an opaque
correlation reference. Deployment passes the reference to its adapter and
records the returned trigger id when available. Lost responses require a
provider that supports lookup by that reference. A lookup grants no replay.

The search reader handles redirects explicitly. It validates network and
egress policy before sending the initial request and every redirected
request. The regression test verifies that a denied second destination
receives no request.

## Tenant and organization lifecycle interleavings

Tenant lifecycle, provider attestation, personal-owner updates and the
governed rename/delete paths take a common inter-process entity lock before
reading mutable state. Tenant creation prepares the knowledge root before
publishing the profile. The contention test verifies that neither a
lifecycle operation nor an attestation can write while the lock is held
and that suspended profiles reject attestation.

Managed project creation establishes the organization link before
publishing the project record. A surviving link blocks organization
archive and is reused by a subsequent create for that project ID. The
archive guard also scans canonical projects owned by the organization,
including a live project whose link is missing. The attachment facade,
organization archive, and project lifecycle mutations share the lock.
The surface acquires it before opening its exact record access grant.

Domain, capability, service and operation writes and retirement use the
same critical section for reads and writes. Retirement checks both stored
links and scoped dependent records. Normal updates refuse known retired
references and cannot reactivate a retired record. The tests exercise
dependent-first and retirement-first orders as well as a direct service
retirement attempt. Existing missing-reference drift remains visible to
the reconciliation checks.

The PR publication host takes the artifact write lock before opening the exact
file grant for the review or body. Repeating publication preparation reuses
only byte-identical evidence and retains a single scoped index entry.

## Actuator dispatch increment

`libs/core/actuator/actuator-dispatch.model.test.ts` specifies one op dispatch
lifecycle — resolve → preflight → validate → dry-run plan → invoke — per step
kind and dry-run flag. It exhausts 74 states and 66 transitions, checking:

- A domain handler runs only after resolution, admission, and accepted input.
- Denial and unknown ops never reach the handler.
- Dry-run never invokes a non-capture handler; capture still observes.
- Success requires an invocation or a declared validate-only path.

It then enumerates production conformance: all 128 dispatch outcome
assignments across the four step kinds, the five-scenario admission lattice of
`runActuatorPipeline` (including block-overrides-grant), eight step-sequence
failure masks, the dry-run plan table, `resolveCliActionKind` verb tables,
120 capability-effect assignments including the undeclared fail-safe default,
entrypoint containment for `resolveActuatorModulePath`, registry data
invariants (pool disjointness, domain-over-shared specialization pinning,
retired-op immutability), and catalog dispatch output normalization. Three
deliberate mutations must each produce the intended counterexample.

```bash
pnpm exec vitest run libs/core/actuator/actuator-dispatch.model.test.ts libs/core/actuator/actuator-sdk.test.ts libs/core/actuator/actuator-op-registry.test.ts
```

Retries, sandbox enforcement, context payloads, and real actuator side effects
remain outside the model; the same assurance boundary applies.

## Voice dispatch increment

`libs/shared-voice/src/voice-dispatch.model.test.ts` covers the reply-speech
pipeline as three independent specifications.

The streaming-playback model (`streamVoicePlayback`) specifies
push → dequeue → synthesize → pause-gate → play, with pause resolved three
ways (handle suspended, handle stopped owing a replay, handle without
`pause()` left running) and segment supply bounded to three. It exhausts 165
states and 537 transitions, checking:

- A segment plays only after synthesis completes and the gate is open.
- `stop()` drains all in-flight work; a stopped controller stays drained.
- A paused player is held exactly one way — suspended, owed a replay, or
  left running — and never two at once.
- A pending replay is owed a spoken segment and blocks later admissions.
- Quiescent success means every admitted segment spoke; a synthesis or
  playback failure drains the run without invoking later segments.

The two-stage barge-in model specifies `listening → paused → stopped` for
`TwoStageBargeIn` under both `streaming_stt` configurations — 30 states and
160 transitions with streaming STT, 34 and 164 without — checking:

- `hard_stop` requires a prior `pause_tts` episode and is terminal for it.
- `resume_tts` requires a pause episode; a stopped episode stays inert until
  `reset()`.
- The fallback hard stop needs sustained speech at the fallback bound and
  applies only without streaming STT.

The phrase chunker is checked differentially: an independent reference
specification of `VoicePhraseChunker` — two-pass sentence-end search with
the `. ` fallback, first-phrase break set and caps — is compared against the
production class over more than 10,000 compositions of ten seed texts into
up to three deltas, plus cap bounds, modulo-whitespace coverage, and a text
walk proving every emitted boundary is a break char or a cap cut. Checking
pinned a documented semantics: `. ` is only a fallback break, so boundaries
around it legitimately depend on which deltas had arrived — both outcomes
are legal cuts, not a partition violation.

Five deliberate mutations must each produce the intended counterexample
(gate bypass, stop leaving in-flight work, phantom replay, listening-phase
hard stop, streaming-STT fallback). Conformance drives the real controllers
with scripted sequences: synthesis/playback deferreds and fake handles for
playback (including the `pause() === false` stop-and-replay path and the
no-`pause()` unpausable path), and fake PCM chunks plus a manual clock for
barge-in (including external VAD start/end accumulation and the
partial-before-audio priority of `observeTick`).

```bash
pnpm exec vitest run libs/shared-voice/src/voice-dispatch.model.test.ts
```

Segments are counted, not bytes; audio RMS collapses to loud/quiet; STT
partials collapse to words/filler/echo; wall time to a manual clock. Real
TTS engines, `ffplay` children, voice-hub HTTP delegation, `streamTtsAudioPlayback`
stream merging, and arbitrary event-loop schedules remain outside the model.

## Video dispatch increment

`libs/core/video/video-frame-bus.model.test.ts` covers the frame path as two
independent specifications.

The bounded-queue model specifies `BoundedVideoQueue` under all three
overflow policies with frame supply bounded to four — 66 states and 112
transitions for `drop_oldest`, 64 and 109 for `drop_newest`, 31 and 52 for
`fail` — checking:

- Queue depth and buffered milliseconds stay within policy on every push.
- Push accounting is complete; every evicted or rejected frame — including
  the frame that triggers a `fail` overflow — is counted as a drop (the
  uncounted `fail` drop was fixed alongside this model).
- Evictions take older frames than the survivors (`drop_oldest`), and
  evicted or rejected frames never resurface in queue or delivery.
- A pending reader receives the frame directly; `close()` drains every
  waiter; a queue failure implies closed and poisons later reads.
- Delivery order is preserved for admitted frames.

The stub-bus model specifies `StubVideoFrameBus` lifecycle — explicit open,
reader- and write-side auto-open, format negotiation, lease acquire/release,
and the degraded path — with writes bounded to three. All three
configurations (leased `drop_oldest`, leased `fail`, lease-free
`drop_newest`) exhaust 173 states and 277 transitions, checking:

- Once closed the bus stays closed and writes are dropped.
- A held device lease requires an open bus; closing or degrading releases it.
- An explicit open locks the negotiated format; a set format implies open.
- A queue failure implies degraded or closed, and a degraded bus accepts no
  more writes — write accounting stays frozen.
- Reader waiters are bounded and a frame written to a waiting reader counts
  as both written and delivered.

Five deliberate mutations must each produce the intended counterexample
(tail-eviction under `drop_oldest`, a waiter registered while the queue is
nonempty, a close that retains waiters, a degraded-bus write, and a queue
error that retains the lease). Conformance drives `BoundedVideoQueue` and
`StubVideoFrameBus` directly: eviction order under each policy, `fail`
poisoning both reads and writes, pending-reader handoff, post-close drain
and the silent post-close write, format adoption and mismatch rejection,
write-side auto-open, lease release on degrade and close, and the resulting
`health()` report.

`libs/shared-video/src/obs-virtual-camera.model.test.ts` specifies the
`applySourceFilter` RPC protocol over obs-websocket:
`GetSourceFilterList` → kind-drift / disabled-create guards → disable-first
`SetSourceFilterEnabled(false)` → `SetSourceFilterSettings` or
`CreateSourceFilter` → `SetSourceFilterEnabled(true)` → `GetSourceFilter`
readback verification. Six request configurations exhaust 3–20 states and
3–27 transitions each, checking:

- A request completes only on a response matching its requestId; stale or
  event frames are ignored.
- Mutation never precedes the filter-list read, and a required disable is
  acknowledged before settings mutate.
- A created filter is enabled only when the request asked for it (OBS
  creates filters enabled, so a disabled create fails closed instead of
  briefly exposing an unrequested effect).
- Success requires a readback-verified world — the model lets a server
  acknowledge a mutation without applying it (`ok:ignored`), and such runs
  can only reach `failed`, never `done`: the readback gate is
  load-bearing.

Four deliberate mutations must each produce the intended counterexample
(stale-response acceptance, mutate-before-disable, skipped readback,
disabled create). Conformance runs the production client against a fake
obs-websocket server and pins the exact request sequences — including a
new case: an acknowledged-but-ignored mutation fails closed with
`OBS_FILTER_UNVERIFIED`.

`libs/shared-video/src/video-filter-apply.model.test.ts` specifies the
provider-neutral `applyVideoFilter` pipeline end to end —
validate → resolve provider → capability gate → probe → prepare → governed
`runExternalOperation` (approval-required, nondelegable) → commit → verify
the returned filter metadata — across five provider configurations:
auto-single and explicit-capable paths exhaust 14 states and 15
transitions; auto-ambiguous and unknown-provider rejections take 3/3; an
unsupported capability exits at 4/4. The model checks every gate in
order: denied approval never commits, an explicit-provider or probe
failure never redispatches to a second provider, capability is checked
before any preparation, and a malformed target digest or a commit result
whose identity differs from the request fails closed. A counted side
effect also implies the pipeline reached its stage: a phase may only
regress to `failed`, never back to an earlier gate. Two deliberate
mutations (redispatch to a second provider, revalidate after a failed
probe) produce the intended counterexamples.

`libs/shared-video/src/camera-output.model.test.ts` covers two seams. The
resolution differential enumerates every registry ordering, availability
mask, and preference against `resolveCameraOutputBridge`: explicit ids
must exist and probe successfully, `auto` skips the `stub` backend and
returns the first probed-available backend **in id order** — the seam
lists providers sorted by id, a semantic difference from the documented
"registration order" that surfaced while writing the spec (the code
comment was corrected). The v4l2 lifecycle model bounds starts to two and
exhausts 35 states / 91 transitions on linux (8/19 off-linux): a lease is
held only inside a live injection, at most one lease exists, settled runs
retain neither lease nor running flag, a device probe precedes every
injection, loop requests never reach the probe, and a healthy report
requires a successful injection. Three mutations (retained lease,
concurrent start, loop bypass) each produce the intended counterexample.
Conformance against the real bridge — including a regression test for a
defect found while writing the model — pins the mid-flight `stop()`
semantics: a stop abandons the in-flight call (its lease is released and
its start-guard cleared), and the abandoned call's settle must not
release a later call's lease, clear its guard, or publish its result into
shared health state (the bridge now tracks per-call lease ownership and a
call token).

`libs/core/virtual/virtual-camera-injection.model.test.ts` models
`resolveSelection` as a 24-cell environment lattice — requested backend ×
platform × device-path × ffmpeg-alive — exhausting 48 states and 24
transitions: an unknown requested backend throws before any selection, a
device backend requires an eligible platform, its required device path,
and a live ffmpeg probe, and the replay fallback reason distinguishes a
requested-but-ineligible backend from no-configured-backend. Two
mutations (ghost-backend fallback, device selection with dead ffmpeg)
produce the intended counterexamples. Conformance drives the production
`probe()` over the real governed registry — including a linux device-mode
selection, a requested-backend-unavailable report, and five `pickCamera`
preference/differential cases (virtual cameras preferred, exact match,
contained match, unmatched fallback, empty-inventory hint).

```bash
pnpm exec vitest run libs/core/video/video-frame-bus.model.test.ts libs/shared-video/src/obs-virtual-camera.model.test.ts libs/shared-video/src/video-filter-apply.model.test.ts libs/shared-video/src/camera-output.model.test.ts libs/core/virtual/virtual-camera-injection.model.test.ts
```

Frames are counted with duration collapsed to a fixed 33 ms; the OBS world
collapses to {exists, enabled, settings-applied, kind-ok}; provider and
backend registries collapse to their capability/eligibility bits; ffmpeg
probing collapses to alive/dead. Real WebSocket framing, the Hello/Identify
handshake and password challenge, wall-clock timeouts, device-lease
contention beyond held/released, settings payload contents, real OBS and
ffmpeg behavior, and multi-backend registries beyond the governed single
entry remain outside the model.

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
