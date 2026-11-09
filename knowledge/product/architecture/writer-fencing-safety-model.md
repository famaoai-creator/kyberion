---
title: Writer fencing input safety model
tags: [formal-methods, verification, lease, fencing, numeric-safety, clocks]
last_updated: 2026-11-08
---

# Writer fencing input safety model

## Safety boundary

The lease backend holds a namespace mutex; writer fencing separately determines
whether a token is current. A monotonically increasing token cannot be
implemented by allowing an unbounded JavaScript Number counter to increment.
[ECMAScript defines MAX_SAFE_INTEGER](https://tc39.es/ecma262/#sec-number.max_safe_integer)
as the limit for safely represented integers. The implementation refuses new
allocation at that limit rather than wrapping, clamping or reusing a fence.

The independent model extends the
[executable safety model pattern](./executable-safety-models.md). It is motivated
by [Kleppmann's fencing analysis](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html):
stale clients must be rejected, independently of their belief that a lease is
still live. This increment checks the local token/clock boundary; it does not
qualify a real distributed storage service.

Source-runtime reproductions showed that a record at MAX_SAFE_INTEGER could
produce the same unsafe fence twice and admit a previous same-owner token.
Non-finite clocks could bypass expiry comparisons or persist invalid expiry
values. Finite clock/duration addition could also overflow.

## Enforced rules

- Persisted fences are nonnegative safe integers; allocation requires remaining
  headroom for a strictly greater safe integer.
- Persisted expiry and every observed clock value are finite and nonnegative.
- Positive fractional durations remain supported. A computed expiry must be
  finite and strictly later than the observed clock, including at magnitudes
  where a small duration would round away.
- Invalid initial inputs, malformed records and invalid arithmetic are rejected
  before writing a new record or entering a protected callback.
- Fresh ownership/expiry checks remain before callback admission and at exit.
  A later clock observation can fail after a valid allocation; this cannot
  retroactively guarantee no prior write. Acquisition releases only its matching
  reservation while retaining the allocated fence. Do not reset the counter.
- Assertion checks durable current expiry rather than requiring the original
  token object's expiry to match: auto-renewal intentionally keeps that token
  while extending the stored expiry.

The canonical implementation is `libs/core/lease/writer-lease.ts`; the local
storage schema is `knowledge/product/schemas/writer-lease.schema.json`. Injected
and memory backends receive the same numeric safety floor at the reader boundary.

## Verification

`libs/core/lease/writer-lease.numeric-model.test.ts` uses explicit input partitions
and a BigInt next-fence oracle rather than importing production validators. Its
finite model explores 2,040 input partitions (4,080 states, 2,040 transitions),
including invalid and near-limit fences, clocks and durations. An overflow
mutation must produce a counterexample. Production comparisons cover sync/async
acquisition and renewal and separate assertion partitions.

Additional regressions cover changing clocks, stale same-owner tokens at the
integer boundary, renewal with an original token and fractional durations. Run:

```bash
KYBERION_TEST_LEAK_STRICT=1 CI=true LANG=C.UTF-8 pnpm exec vitest run libs/core/lease/writer-lease.numeric-model.test.ts libs/core/lease/writer-lease.test.ts libs/core/lease/lease-backend.test.ts libs/core/agent/nhi-lifecycle-governance.test.ts
```

This exhausts the supplied finite partition model, not all IEEE-754 values or all
clock histories. It does not prove monotonic physical clocks, rollback of callback
side effects, real distributed exclusion, crash recovery, fairness or liveness.
The separate backend exclusion model and regression suite remain necessary.
