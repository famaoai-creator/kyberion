import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import schema from '../../../knowledge/product/schemas/writer-lease.schema.json' with { type: 'json' };
import { checkFiniteStateSafety, type SafetyModel } from '../testing/finite-state-checker.js';
import type { LeaseBackend } from './lease-backend.js';
import {
  assertFencedWriterLease,
  renewFencedWriterLease,
  renewFencedWriterLeaseSync,
  withFencedWriterLease,
  withFencedWriterLeaseSync,
  type FencedWriterLease,
} from './writer-lease.js';

const MAX = Number.MAX_SAFE_INTEGER;
const MAX_BIG = 9_007_199_254_740_991n;
const record = (fence: number, expires_at_ms: number): FencedWriterLease => ({
  resource_id: 'numeric-model',
  owner_id: 'owner',
  fence,
  expires_at_ms,
});
const records = [
  undefined,
  record(0, 0),
  record(1, 0),
  record(1, 10),
  record(1, 0.5),
  record(MAX - 1, 0),
  record(MAX, 0),
  record(MAX, Number.MAX_VALUE),
  record(MAX + 1, 0),
  record(-1, 0),
  record(0.5, 0),
  record(NaN, 0),
  record(Infinity, 0),
  record(1, -1),
  record(1, NaN),
  record(1, Infinity),
  record(1, Number.MAX_VALUE),
];
const clocks = [
  -Infinity,
  NaN,
  Infinity,
  -1,
  0,
  0.5,
  9,
  10,
  11,
  MAX,
  Number.MAX_VALUE / 2,
  Number.MAX_VALUE,
];
const ttls = [-Infinity, NaN, Infinity, -1, 0, Number.MIN_VALUE, 0.5, 1, 10, Number.MAX_VALUE];
interface Input {
  id: number;
  seed: FencedWriterLease | undefined;
  now: number;
  ttl: number;
}
const inputs: Input[] = [];
for (const seed of records)
  for (const now of clocks)
    for (const ttl of ttls) {
      inputs.push({ id: inputs.length, seed, now, ttl });
    }

// Independent input-partition specification. BigInt is the fence arithmetic
// oracle: the production implementation must not wrap, round, clamp or reset.
const validTime = (n: number) => Number.isFinite(n) && n >= 0;
const validRecord = (lease: FencedWriterLease) =>
  Number.isSafeInteger(lease.fence) && lease.fence >= 0 && validTime(lease.expires_at_ms);
function oracle(input: Input, renewal = false): FencedWriterLease | undefined {
  const { seed, now, ttl } = input;
  if (!validTime(now) || !Number.isFinite(ttl) || ttl <= 0 || (seed && !validRecord(seed))) return;
  const expiry = now + ttl;
  if (!Number.isFinite(expiry) || expiry <= now) return;
  if (renewal)
    return seed && seed.expires_at_ms > now ? { ...seed, expires_at_ms: expiry } : undefined;
  if (seed && seed.expires_at_ms > now) return;
  const next = BigInt(seed?.fence ?? 0) + 1n;
  if (next > MAX_BIG) return;
  return record(Number(next), expiry);
}

function fixture(seed?: FencedWriterLease) {
  let current = seed && { ...seed };
  const writes: FencedWriterLease[] = [];
  const backend: LeaseBackend = {
    id: 'numeric-model',
    withLock: (_namespace, fn) => fn(),
    withLockSync: (_namespace, fn) => fn(),
    read: () => current && { ...current },
    write: (_key, lease) => {
      current = { ...lease };
      writes.push({ ...lease });
    },
  };
  return { backend, writes, read: () => current };
}

interface State {
  input: Input;
  after: boolean;
  admitted?: FencedWriterLease;
}
const model: SafetyModel<State> = {
  initial: inputs.map((input) => ({ input, after: false })),
  key: (s) => `${s.input.id}:${s.after}`,
  next: (s) =>
    s.after
      ? []
      : [
          {
            action: 'acquire',
            state: {
              input: s.input,
              after: true,
              admitted: oracle(s.input),
            },
          },
        ],
  invariants: {
    'admitted fence is a strictly increasing safe integer': (s) =>
      !s.admitted ||
      (Number.isSafeInteger(s.admitted.fence) &&
        BigInt(s.admitted.fence) > BigInt(s.input.seed?.fence ?? 0)),
    'admitted expiry is finite and strictly future': (s) =>
      !s.admitted ||
      (Number.isFinite(s.admitted.expires_at_ms) && s.admitted.expires_at_ms > s.input.now),
    'admission preserves valid clock, duration and record domains': (s) =>
      !s.admitted ||
      (validTime(s.input.now) &&
        Number.isFinite(s.input.ttl) &&
        s.input.ttl > 0 &&
        (!s.input.seed || validRecord(s.input.seed))),
  },
};

describe('writer lease numeric safety model', () => {
  it('exhausts the finite input partitions using exact fence arithmetic', () => {
    expect(inputs).toHaveLength(2040);
    expect(checkFiniteStateSafety(model)).toEqual({
      status: 'verified',
      visited: 4080,
      transitions: 2040,
    });
  });

  it('detects a mutant that admits unsafe number-based fence increments', () => {
    const input = { id: 0, seed: record(MAX, 0), now: 0, ttl: 1 };
    const result = checkFiniteStateSafety({
      ...model,
      initial: [{ input, after: false }],
      next: (s) =>
        s.after
          ? []
          : [
              {
                action: 'unchecked-increment',
                state: {
                  input,
                  after: true,
                  admitted: record(input.seed.fence + 1, 1),
                },
              },
            ],
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('admitted fence is a strictly increasing safe integer');
    expect(result.trace?.map((step) => step.action)).toEqual(['initial', 'unchecked-increment']);
  });

  for (const asynchronous of [false, true]) {
    it(`matches acquisition for all numeric partitions (async=${asynchronous})`, async () => {
      for (const input of inputs) {
        const expected = oracle(input);
        const state = fixture(input.seed);
        let calls = 0;
        let token: FencedWriterLease | undefined;
        let accepted = false;
        const options = {
          resourceId: 'numeric-model',
          ownerId: 'owner',
          leasePath: '/numeric-model',
          backend: state.backend,
          nowMs: () => input.now,
          ttlMs: input.ttl,
          fn: (lease: FencedWriterLease) => {
            calls++;
            token = { ...lease };
          },
        };
        try {
          if (asynchronous) await withFencedWriterLease(options);
          else withFencedWriterLeaseSync(options);
          accepted = true;
        } catch {
          /* Expected refusal is compared with the independent oracle. */
        }
        expect(accepted, `partition ${input.id}`).toBe(Boolean(expected));
        if (expected) {
          expect(token).toEqual(expected);
          expect(calls).toBe(1);
          expect(state.read()).toEqual({ ...expected, expires_at_ms: 0 });
        } else {
          expect(calls).toBe(0);
          expect(state.writes).toEqual([]);
          expect(state.read()).toEqual(input.seed);
        }
      }
    });

    it(`matches renewal for all numeric partitions (async=${asynchronous})`, async () => {
      for (const input of inputs) {
        const expected = oracle(input, true);
        const state = fixture(input.seed);
        const options = {
          resourceId: 'numeric-model',
          ownerId: 'owner',
          leasePath: '/numeric-model',
          backend: state.backend,
          nowMs: () => input.now,
          ttlMs: input.ttl,
          lease: input.seed ?? record(1, 0),
        };
        let renewed: FencedWriterLease | undefined;
        try {
          renewed = asynchronous
            ? await renewFencedWriterLease(options)
            : renewFencedWriterLeaseSync(options);
        } catch {
          /* Expected refusal is compared with the independent oracle. */
        }
        expect(renewed, `partition ${input.id}`).toEqual(expected);
        expect(state.read()).toEqual(expected ?? input.seed);
        expect(state.writes).toHaveLength(expected ? 1 : 0);
      }
    });
  }

  it('matches assertion before, at and after expiry including invalid clocks and injected records', () => {
    for (const seed of records)
      for (const now of clocks) {
        const state = fixture(seed);
        const expected = Boolean(
          seed && validRecord(seed) && validTime(now) && seed.expires_at_ms > now
        );
        let accepted = false;
        try {
          assertFencedWriterLease('/numeric-model', seed ?? record(1, 0), now, state.backend);
          accepted = true;
        } catch {
          /* Compared to the independent assertion predicate below. */
        }
        expect(accepted, `fence=${seed?.fence}, expiry=${seed?.expires_at_ms}, now=${now}`).toBe(
          expected
        );
        expect(state.writes).toEqual([]);
      }
  });

  it('grants the last safe fence once and refuses same-owner exhaustion without making stale tokens current', () => {
    const state = fixture(record(MAX - 1, 0));
    let last!: FencedWriterLease;
    const options = {
      resourceId: 'numeric-model',
      ownerId: 'owner',
      leasePath: '/numeric-model',
      backend: state.backend,
      nowMs: () => 0,
      ttlMs: 1,
      fn: (lease: FencedWriterLease) => {
        last = { ...lease };
      },
    };
    withFencedWriterLeaseSync(options);
    expect(last.fence).toBe(MAX);
    expect(() => assertFencedWriterLease('/numeric-model', last, 0, state.backend)).toThrow();
    const released = { ...state.read()! };
    expect(() => withFencedWriterLeaseSync(options)).toThrow(/EXHAUSTED/);
    expect(state.read()).toEqual(released);
    expect(state.writes).toHaveLength(2);
  });

  it('accepts a renewed current lease using the original token object even after its original expiry', () => {
    const token = record(1, 1);
    const state = fixture(token);
    renewFencedWriterLeaseSync({
      resourceId: 'numeric-model',
      ownerId: 'owner',
      leasePath: '/numeric-model',
      backend: state.backend,
      nowMs: () => 0.5,
      ttlMs: 10,
      lease: token,
    });
    expect(() => assertFencedWriterLease('/numeric-model', token, 2, state.backend)).not.toThrow();
    expect(token.expires_at_ms).toBe(1);
  });

  it('preserves callback failure identity and releases its valid fence', async () => {
    for (const asynchronous of [false, true]) {
      const state = fixture();
      const failure = new Error('protected callback failed');
      const options = {
        resourceId: 'numeric-model',
        ownerId: 'owner',
        leasePath: '/numeric-model',
        backend: state.backend,
        nowMs: () => 0.25,
        ttlMs: 0.5,
        fn: () => {
          throw failure;
        },
      };
      if (asynchronous) await expect(withFencedWriterLease(options)).rejects.toBe(failure);
      else expect(() => withFencedWriterLeaseSync(options)).toThrow(failure);
      expect(state.read()).toEqual(record(1, 0));
    }
  });

  it('checks a fresh clock before callback admission and releases a failed reservation without rolling back its fence', async () => {
    for (const asynchronous of [false, true])
      for (const later of [NaN, Infinity, -Infinity, -1, 1]) {
        const state = fixture();
        let samples = 0;
        let calls = 0;
        const options = {
          resourceId: 'numeric-model',
          ownerId: 'owner',
          leasePath: '/numeric-model',
          backend: state.backend,
          nowMs: () => (samples++ === 0 ? 0 : later),
          ttlMs: 1,
          fn: () => {
            calls++;
          },
        };
        const error = later === 1 ? /WRITER_LEASE_FENCED/ : /nowMs/;
        if (asynchronous) await expect(withFencedWriterLease(options)).rejects.toThrow(error);
        else expect(() => withFencedWriterLeaseSync(options)).toThrow(error);
        expect(samples).toBe(2);
        expect(calls).toBe(0);
        expect(state.writes).toEqual([record(1, 1), record(1, 0)]);
        expect(
          withFencedWriterLeaseSync({ ...options, nowMs: () => 0, fn: (lease) => lease.fence })
        ).toBe(2);
        expect(() =>
          assertFencedWriterLease('/numeric-model', record(1, 1), 0, state.backend)
        ).toThrow(/FENCED/);
      }
  });

  it('validates the callback-exit observation and still releases on a later clock failure', async () => {
    for (const asynchronous of [false, true]) {
      const state = fixture();
      let samples = 0;
      let calls = 0;
      const options = {
        resourceId: 'numeric-model',
        ownerId: 'owner',
        leasePath: '/numeric-model',
        backend: state.backend,
        nowMs: () => (samples++ < 2 ? 0 : NaN),
        ttlMs: 1,
        fn: () => {
          calls++;
        },
      };
      if (asynchronous) await expect(withFencedWriterLease(options)).rejects.toThrow(/nowMs/);
      else expect(() => withFencedWriterLeaseSync(options)).toThrow(/nowMs/);
      expect(calls).toBe(1);
      expect(samples).toBe(3);
      expect(state.writes).toEqual([record(1, 1), record(1, 0)]);
    }
  });

  it('checks renewal again after writing without claiming a later clock fault can undo a valid write', async () => {
    for (const asynchronous of [false, true])
      for (const later of [NaN, 11]) {
        const token = record(1, 1);
        const state = fixture(token);
        let samples = 0;
        const options = {
          resourceId: 'numeric-model',
          ownerId: 'owner',
          leasePath: '/numeric-model',
          backend: state.backend,
          nowMs: () => (samples++ === 0 ? 0.5 : later),
          ttlMs: 10,
          lease: token,
        };
        const error = Number.isNaN(later) ? /nowMs/ : /FENCED/;
        if (asynchronous) await expect(renewFencedWriterLease(options)).rejects.toThrow(error);
        else expect(() => renewFencedWriterLeaseSync(options)).toThrow(error);
        expect(samples).toBe(2);
        expect(state.writes).toEqual([record(1, 10.5)]);
        expect(state.read()).toEqual(record(1, 10.5));
        expect(() =>
          assertFencedWriterLease('/numeric-model', token, 2, state.backend)
        ).not.toThrow();
      }
  });

  it('preserves an initial clock exception before any write or callback', async () => {
    for (const asynchronous of [false, true]) {
      const state = fixture();
      const failure = new Error('clock unavailable');
      let calls = 0;
      const options = {
        resourceId: 'numeric-model',
        ownerId: 'owner',
        leasePath: '/numeric-model',
        backend: state.backend,
        nowMs: () => {
          throw failure;
        },
        ttlMs: 1,
        fn: () => {
          calls++;
        },
      };
      if (asynchronous) await expect(withFencedWriterLease(options)).rejects.toBe(failure);
      else expect(() => withFencedWriterLeaseSync(options)).toThrow(failure);
      expect(calls).toBe(0);
      expect(state.writes).toEqual([]);
    }
  });

  it('schema accepts only safe nonnegative fences and finite nonnegative expiries', () => {
    const Ajv = (AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule;
    const validate = new Ajv({ strictNumbers: true }).compile(schema);
    for (const seed of records.filter((r): r is FencedWriterLease => Boolean(r))) {
      expect(validate(seed), `fence=${seed.fence}, expiry=${seed.expires_at_ms}`).toBe(
        validRecord(seed)
      );
    }
  });
});
