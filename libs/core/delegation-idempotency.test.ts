import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeDelegationPayloadHash,
  DelegationIdempotencyConflictError,
  deriveDelegationIdempotencyKey,
  loadDelegationReservation,
  resetDelegationIdempotencyForTests,
  runIdempotentDelegation,
} from './delegation-idempotency.js';
import { DelegationTerminalError, markDelegationExecutionStarted } from './delegation-result.js';

function freshKey(): string {
  return deriveDelegationIdempotencyKey({ workItemId: `witem-${randomUUID()}`, attempt: 1 });
}

describe('R5 delegation idempotency', () => {
  beforeEach(() => resetDelegationIdempotencyForTests());

  it('derives a key from work item + attempt and rejects invalid input', () => {
    expect(deriveDelegationIdempotencyKey({ workItemId: 'witem-1', attempt: 2 })).toBe(
      'work-item:witem-1:attempt:2'
    );
    expect(() => deriveDelegationIdempotencyKey({ workItemId: '', attempt: 1 })).toThrow();
    expect(() => deriveDelegationIdempotencyKey({ workItemId: 'w', attempt: -1 })).toThrow();
  });

  it('hashes execution-relevant payload only', () => {
    const base = computeDelegationPayloadHash({
      instruction: 'do it',
      context: 'ctx',
      options: { effort: 'low', model_tier: 'fast' },
    });
    expect(
      computeDelegationPayloadHash({
        instruction: 'do it',
        context: 'ctx',
        options: {
          model_tier: 'fast',
          effort: 'low',
          signal: new AbortController().signal,
          idempotencyKey: 'k',
          delegation_result: { mode: 'summary' },
        },
      })
    ).toBe(base);
    expect(
      computeDelegationPayloadHash({
        instruction: 'do it',
        context: 'ctx',
        options: { effort: 'high' },
      })
    ).not.toBe(base);
    expect(computeDelegationPayloadHash({ instruction: 'do it!', context: 'ctx' })).not.toBe(base);
  });

  it('passes through when no key is supplied', async () => {
    const execute = vi.fn(async () => 'ran');
    await expect(runIdempotentDelegation({ instruction: 'x', execute })).resolves.toBe('ran');
    await expect(runIdempotentDelegation({ instruction: 'x', execute })).resolves.toBe('ran');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('joins an in-flight execution and replays the stored result after terminal', async () => {
    const idempotencyKey = freshKey();
    let release!: (value: string) => void;
    const execute = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const first = runIdempotentDelegation({
      instruction: 'x',
      options: { idempotencyKey },
      execute,
    });
    const second = runIdempotentDelegation({
      instruction: 'x',
      options: { idempotencyKey },
      execute,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    release('result-1');
    await expect(first).resolves.toBe('result-1');
    await expect(second).resolves.toBe('result-1');

    resetDelegationIdempotencyForTests();
    await expect(
      runIdempotentDelegation({ instruction: 'x', options: { idempotencyKey }, execute })
    ).resolves.toBe('result-1');
    expect(execute).toHaveBeenCalledTimes(1);
    const stored = loadDelegationReservation(idempotencyKey);
    expect(stored).toMatchObject({ status: 'terminal', result: { status: 'completed' } });
    expect(stored?.started_at).toBeTruthy();
  });

  it('rejects the same key with a different payload without executing', async () => {
    const idempotencyKey = freshKey();
    await runIdempotentDelegation({
      instruction: 'original',
      options: { idempotencyKey },
      execute: async () => 'ok',
    });
    const execute = vi.fn(async () => 'should not run');
    await expect(
      runIdempotentDelegation({ instruction: 'changed', options: { idempotencyKey }, execute })
    ).rejects.toBeInstanceOf(DelegationIdempotencyConflictError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a conflicting payload while the first execution is still in flight', async () => {
    const idempotencyKey = freshKey();
    let release!: (value: string) => void;
    const first = runIdempotentDelegation({
      instruction: 'a',
      options: { idempotencyKey },
      execute: () => new Promise<string>((resolve) => (release = resolve)),
    });
    const execute = vi.fn(async () => 'b');
    await expect(
      runIdempotentDelegation({ instruction: 'b', options: { idempotencyKey }, execute })
    ).rejects.toBeInstanceOf(DelegationIdempotencyConflictError);
    release('a');
    await first;
    expect(execute).not.toHaveBeenCalled();
  });

  it('releases the reservation when the failure provably happened before start', async () => {
    const idempotencyKey = freshKey();
    await expect(
      runIdempotentDelegation({
        instruction: 'x',
        options: { idempotencyKey },
        execute: async () => {
          throw new Error('spawn claude ENOENT');
        },
      })
    ).rejects.toThrow('ENOENT');
    expect(loadDelegationReservation(idempotencyKey)?.status).toBe('released');
    await expect(
      runIdempotentDelegation({
        instruction: 'x',
        options: { idempotencyKey },
        execute: async () => 'second try ran',
      })
    ).resolves.toBe('second try ran');
  });

  it('replays a failure after start instead of re-running it', async () => {
    const idempotencyKey = freshKey();
    await expect(
      runIdempotentDelegation({
        instruction: 'x',
        options: { idempotencyKey },
        execute: async () => {
          markDelegationExecutionStarted();
          throw new Error('401 unauthorized mid-run');
        },
      })
    ).rejects.toThrow('mid-run');
    const execute = vi.fn(async () => 'must not run');
    const replay = runIdempotentDelegation({
      instruction: 'x',
      options: { idempotencyKey },
      execute,
    });
    await expect(replay).rejects.toBeInstanceOf(DelegationTerminalError);
    await replay.catch((error: DelegationTerminalError) => {
      expect(error.delegationResult.status).toBe('failed');
      expect(error.delegationResult.error?.allowFailover).toBe(false);
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('treats an unknown start state as started (conservative)', async () => {
    const idempotencyKey = freshKey();
    await expect(
      runIdempotentDelegation({
        instruction: 'x',
        options: { idempotencyKey },
        execute: async () => {
          throw new Error('provider crashed');
        },
      })
    ).rejects.toThrow('provider crashed');
    expect(loadDelegationReservation(idempotencyKey)?.status).toBe('terminal');
  });

  it('adopts a stale reservation of this pid that never started', async () => {
    const idempotencyKey = freshKey();
    let release!: (value: string) => void;
    const abandoned = runIdempotentDelegation({
      instruction: 'x',
      options: { idempotencyKey },
      execute: () => new Promise<string>((resolve) => (release = resolve)),
    });
    // Simulate a lost in-process entry (e.g. a recycled pid after a crash).
    resetDelegationIdempotencyForTests();
    await expect(
      runIdempotentDelegation({
        instruction: 'x',
        options: { idempotencyKey },
        execute: async () => 'adopted',
      })
    ).resolves.toBe('adopted');
    release('late');
    await abandoned;
  });
});
