import { afterEach, describe, expect, it } from 'vitest';
import { safeRmSync } from '../secure-io.js';
import { DOT_TOKEN_USAGE_PATH, readDotTokenUsageForDay } from './dot-token-usage.js';
import { createDotSemanticSharedBudgetPort } from './dot-semantic-budget.js';
import type { DotSemanticBudgetOwner } from './dot-semantic-judgment.js';
import * as path from 'node:path';

const TEST_ROOT = 'active/shared/tmp/dot-semantic-budget-tests';

const owner: DotSemanticBudgetOwner = {
  dot_id: 'budget-dot',
  accounting_id: 'acc-1',
  scope_hash: 'a'.repeat(64),
  day: '2026-11-27',
};

const fixedNow = () => new Date('2026-11-27T10:00:00.000Z');

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('createDotSemanticSharedBudgetPort', () => {
  it('reserves atomically, settles exact usage into dot-token-usage, and refunds unused allowance', () => {
    const port = createDotSemanticSharedBudgetPort({
      rootDir: TEST_ROOT,
      now: fixedNow,
      dailyTokenCap: 1000,
      readOrgDailyCap: () => 5000,
    });

    const first = port.reserve({ parent: owner, reservation_key: 'k1', max_tokens: 600 });
    expect(first.status).toBe('reserved');
    if (first.status !== 'reserved') return;
    expect(first.token_allowance).toBe(600);

    // Concurrent reservation only sees the remaining 400 tokens.
    const second = port.reserve({ parent: owner, reservation_key: 'k2', max_tokens: 600 });
    expect(second.status).toBe('reserved');
    if (second.status !== 'reserved') return;
    expect(second.token_allowance).toBe(400);

    // Third reservation fails when remaining is 0.
    expect(port.reserve({ parent: owner, reservation_key: 'k3', max_tokens: 100 })).toEqual({
      status: 'unavailable',
    });

    // Settling first reservation with 150 tokens releases 450 tokens back to the pool.
    const usage = {
      calls: 1,
      input_tokens: 100,
      output_tokens: 50,
      elapsed_ms: 120,
      usage_status: 'reported' as const,
    };
    expect(port.settle(first.handle, owner, usage)).toEqual({ status: 'settled' });
    // Idempotent re-settle succeeds with identical usage, rejects changed usage.
    expect(port.settle(first.handle, owner, usage)).toEqual({ status: 'settled' });
    expect(() => port.settle(first.handle, owner, { ...usage, output_tokens: 60 })).toThrow(
      /different usage/
    );

    const rows = readDotTokenUsageForDay(path.join(TEST_ROOT, DOT_TOKEN_USAGE_PATH), '2026-11-27');
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens).toBe(150);

    // Remaining capacity is now 1000 - 150 (settled) - 400 (second still reserved) = 450.
    const third = port.reserve({ parent: owner, reservation_key: 'k3', max_tokens: 500 });
    expect(third.status).toBe('reserved');
    if (third.status === 'reserved') {
      expect(third.token_allowance).toBe(450);
    }
  });

  it('retains held_unknown reservations against subsequent reserves and rejects foreign handles', () => {
    const portA = createDotSemanticSharedBudgetPort({
      rootDir: TEST_ROOT,
      now: fixedNow,
      dailyTokenCap: 500,
      readOrgDailyCap: () => 500,
    });
    const portB = createDotSemanticSharedBudgetPort({
      rootDir: TEST_ROOT,
      now: fixedNow,
      dailyTokenCap: 500,
      readOrgDailyCap: () => 500,
    });

    const res = portA.reserve({ parent: owner, reservation_key: 'k1', max_tokens: 400 });
    expect(res.status).toBe('reserved');
    if (res.status !== 'reserved') return;

    expect(portA.holdUnknown(res.handle, owner)).toEqual({ status: 'held_unknown' });
    expect(portA.reserve({ parent: owner, reservation_key: 'k2', max_tokens: 300 })).toMatchObject({
      status: 'reserved',
      token_allowance: 100,
    });

    // Foreign handle or wrong owner must fail closed.
    expect(() => portB.holdUnknown(res.handle, owner)).toThrow(/Foreign/);
    expect(() =>
      portA.settle(
        res.handle,
        { ...owner, dot_id: 'other-dot' },
        { calls: 0, input_tokens: 0, output_tokens: 0, elapsed_ms: 0, usage_status: 'not_invoked' }
      )
    ).toThrow(/owner mismatch/);
  });

  it('resets remaining daily allowance on UTC day rollover', () => {
    let day = '2026-11-27T23:59:00.000Z';
    const port = createDotSemanticSharedBudgetPort({
      rootDir: TEST_ROOT,
      now: () => new Date(day),
      dailyTokenCap: 200,
      readOrgDailyCap: () => 200,
    });
    const r1 = port.reserve({ parent: owner, reservation_key: 'k1', max_tokens: 200 });
    expect(r1.status).toBe('reserved');
    if (r1.status === 'reserved') {
      port.holdUnknown(r1.handle, owner);
    }
    expect(port.reserve({ parent: owner, reservation_key: 'k2', max_tokens: 50 })).toEqual({
      status: 'unavailable',
    });

    day = '2026-11-28T00:01:00.000Z';
    const nextOwner = { ...owner, day: '2026-11-28' };
    const r2 = port.reserve({ parent: nextOwner, reservation_key: 'k3', max_tokens: 200 });
    expect(r2.status).toBe('reserved');
  });
});
