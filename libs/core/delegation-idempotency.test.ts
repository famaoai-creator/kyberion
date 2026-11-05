import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeDelegationPayloadHash,
  DelegationIdempotencyConflictError,
  deriveDelegationIdempotencyKey,
  configureDelegationIdempotencyForTests,
  delegationIdempotencyOwnerForTests,
  delegationReservationPathForTests,
  loadDelegationReservation,
  resetDelegationIdempotencyForTests,
  runIdempotentDelegation,
} from './delegation-idempotency.js';
import {
  DelegationTerminalError,
  markDelegationExecutionStarted,
  markErrorExecutionStarted,
} from './delegation-result.js';
import { tenantRuntimePartitionOf } from './storage-layout.js';
import { runInResourceAccessScope } from './foundation/resource-access-scope.js';
import { safeWriteFile } from './secure-io.js';
import { logger } from './core.js';

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

  it('releases the reservation only on a structural pre-start proof', async () => {
    const idempotencyKey = freshKey();
    await expect(
      runIdempotentDelegation({
        instruction: 'x',
        options: { idempotencyKey },
        execute: async () => {
          throw Object.assign(new Error('spawn claude ENOENT'), {
            code: 'ENOENT',
            syscall: 'spawn claude',
          });
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

  it('never releases on a message-classified failure (agentic CLIs print these after tools)', async () => {
    const idempotencyKey = freshKey();
    await expect(
      runIdempotentDelegation({
        instruction: 'x',
        options: { idempotencyKey },
        execute: async () => {
          throw new Error('401 unauthorized: login required');
        },
      })
    ).rejects.toThrow('401');
    expect(loadDelegationReservation(idempotencyKey)?.status).toBe('terminal');
    const execute = vi.fn(async () => 'must not run');
    await expect(
      runIdempotentDelegation({ instruction: 'x', options: { idempotencyKey }, execute })
    ).rejects.toBeInstanceOf(DelegationTerminalError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('replays a failure after start instead of re-running it', async () => {
    const idempotencyKey = freshKey();
    await expect(
      runIdempotentDelegation({
        instruction: 'x',
        options: { idempotencyKey },
        execute: async () => {
          markDelegationExecutionStarted();
          throw new Error('mid-run failure');
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

  it('persists the assumed start before execute() runs', async () => {
    const idempotencyKey = freshKey();
    let seen: unknown;
    await runIdempotentDelegation({
      instruction: 'x',
      options: { idempotencyKey },
      execute: async () => {
        seen = loadDelegationReservation(idempotencyKey);
        return 'ok';
      },
    });
    expect(seen).toMatchObject({ status: 'in_flight', started_at: expect.any(String) });
  });

  it('settles an owner that crashed mid-execution as interrupted — no re-run without a start mark', async () => {
    const idempotencyKey = freshKey();
    const now = new Date().toISOString();
    seedInFlight(idempotencyKey, {
      owner_pid: 2_147_000_000,
      owner_instance: 'crashed-instance',
      owner_host: delegationIdempotencyOwnerForTests().host,
      heartbeat_at: now,
      started_at: now,
    });
    const execute = vi.fn(async () => 'must not run');
    const replay = runIdempotentDelegation({
      instruction: 'x',
      options: { idempotencyKey },
      execute,
    });
    await expect(replay).rejects.toBeInstanceOf(DelegationTerminalError);
    await replay.catch((error: DelegationTerminalError) => {
      expect(error.delegationResult).toMatchObject({
        status: 'incomplete',
        incomplete_reason: 'interrupted',
        error: { allowFailover: false },
      });
    });
    expect(execute).not.toHaveBeenCalled();
    expect(loadDelegationReservation(idempotencyKey)?.status).toBe('terminal');
  });

  it('settles a lost in-process execution as interrupted, never adopting it', async () => {
    const idempotencyKey = freshKey();
    let release: ((value: string) => void) | undefined;
    const abandoned = runIdempotentDelegation({
      instruction: 'x',
      options: { idempotencyKey },
      execute: () => new Promise<string>((resolve) => (release = resolve)),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    resetDelegationIdempotencyForTests();
    const execute = vi.fn(async () => 'must not run');
    await expect(
      runIdempotentDelegation({ instruction: 'x', options: { idempotencyKey }, execute })
    ).rejects.toThrow('[DELEGATION_INTERRUPTED]');
    expect(execute).not.toHaveBeenCalled();
    // The late owner finds its record already settled: that inconsistency is an error log.
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    release?.('late');
    await abandoned;
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('already settled by another caller')
    );
    errorSpy.mockRestore();
  });

  it('never judges another host by local pid; a fresh lease is waited on with a bounded wait', async () => {
    configureDelegationIdempotencyForTests({ pollMs: 5, maxWaitMs: 40 });
    const idempotencyKey = freshKey();
    const now = new Date().toISOString();
    seedInFlight(idempotencyKey, {
      owner_pid: 2_147_000_000,
      owner_instance: 'remote-instance',
      owner_host: 'another-host.example',
      heartbeat_at: now,
      started_at: now,
    });
    const execute = vi.fn(async () => 'must not run');
    await expect(
      runIdempotentDelegation({ instruction: 'x', options: { idempotencyKey }, execute })
    ).rejects.toThrow('[DELEGATION_IDEMPOTENCY_WAIT_TIMEOUT]');
    expect(execute).not.toHaveBeenCalled();
    expect(loadDelegationReservation(idempotencyKey)?.status).toBe('in_flight');
  });

  it('settles another host whose heartbeat lease expired as interrupted', async () => {
    configureDelegationIdempotencyForTests({ leaseMs: 1000 });
    const idempotencyKey = freshKey();
    const stale = new Date(Date.now() - 60_000).toISOString();
    seedInFlight(idempotencyKey, {
      owner_pid: process.pid,
      owner_instance: 'remote-instance',
      owner_host: 'another-host.example',
      heartbeat_at: stale,
      started_at: stale,
    });
    const execute = vi.fn(async () => 'must not run');
    await expect(
      runIdempotentDelegation({ instruction: 'x', options: { idempotencyKey }, execute })
    ).rejects.toThrow('stopped heartbeating');
    expect(execute).not.toHaveBeenCalled();
  });

  it('waits on a live owner with the same pid but another module instance', async () => {
    configureDelegationIdempotencyForTests({ pollMs: 5, maxWaitMs: 40 });
    const idempotencyKey = freshKey();
    const now = new Date().toISOString();
    seedInFlight(idempotencyKey, {
      owner_pid: process.pid,
      owner_instance: 'other-module-instance',
      owner_host: delegationIdempotencyOwnerForTests().host,
      heartbeat_at: now,
      started_at: now,
    });
    const execute = vi.fn(async () => 'must not run');
    await expect(
      runIdempotentDelegation({ instruction: 'x', options: { idempotencyKey }, execute })
    ).rejects.toThrow('[DELEGATION_IDEMPOTENCY_WAIT_TIMEOUT]');
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets a joiner abort on its own signal while the first execution continues', async () => {
    const idempotencyKey = freshKey();
    let release: ((value: string) => void) | undefined;
    const first = runIdempotentDelegation({
      instruction: 'x',
      options: { idempotencyKey },
      execute: () => new Promise<string>((resolve) => (release = resolve)),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const controller = new AbortController();
    const joiner = runIdempotentDelegation({
      instruction: 'x',
      options: { idempotencyKey, signal: controller.signal },
      execute: async () => 'unused',
    });
    controller.abort(new Error('joiner stopped'));
    await expect(joiner).rejects.toThrow('joiner stopped');
    release?.('first done');
    await expect(first).resolves.toBe('first done');
  });

  it("releases the key when the owner's own signal fired before dispatch", async () => {
    const idempotencyKey = freshKey();
    const controller = new AbortController();
    controller.abort(new Error('owner cancelled'));
    const execute = vi.fn(async () => 'must not run');
    await expect(
      runIdempotentDelegation({
        instruction: 'x',
        options: { idempotencyKey, signal: controller.signal },
        execute,
      })
    ).rejects.toThrow('owner cancelled');
    expect(execute).not.toHaveBeenCalled();
    expect(loadDelegationReservation(idempotencyKey)?.status).toBe('released');
    await expect(
      runIdempotentDelegation({ instruction: 'x', options: { idempotencyKey }, execute })
    ).resolves.toBe('must not run');
  });

  it("does not hand a joiner the owner's pre-start failure — the joiner runs it itself", async () => {
    const idempotencyKey = freshKey();
    let failOwner!: (error: unknown) => void;
    const owner = runIdempotentDelegation({
      instruction: 'x',
      options: { idempotencyKey },
      execute: () => new Promise<string>((_, reject) => (failOwner = reject)),
    });
    await vi.waitFor(() => expect(failOwner).toBeTypeOf('function'));
    const joinerExecute = vi.fn(async () => 'joiner ran');
    const joiner = runIdempotentDelegation({
      instruction: 'x',
      options: { idempotencyKey },
      execute: joinerExecute,
    });
    // The owner is aborted before dispatch (a proven pre-start failure).
    failOwner(markErrorExecutionStarted(new Error('owner aborted before dispatch'), false));
    await expect(owner).rejects.toThrow('owner aborted before dispatch');
    await expect(joiner).resolves.toBe('joiner ran');
    expect(joinerExecute).toHaveBeenCalledTimes(1);
    expect(loadDelegationReservation(idempotencyKey)).toMatchObject({
      status: 'terminal',
      result: { status: 'completed', output_text: 'joiner ran' },
    });
  });

  it('stores tenant reservations in the registered tier/tenant partition', () => {
    const idempotencyKey = freshKey();
    const tenantPath = runInResourceAccessScope(
      { tenantSlug: 'acme', readExact: [], writeExact: [], mkdirExact: [] },
      () => delegationReservationPathForTests(idempotencyKey)
    );
    // Vitest redirects the live subtree; judge the production repo-relative path.
    const repoRelative = (absolute: string) =>
      'active/' +
      absolute
        .replace(/\\/gu, '/')
        .slice(absolute.replace(/\\/gu, '/').lastIndexOf('shared/runtime/delegation-idempotency/'));
    // Registered partition: tier-guard's tenant check and tenant offboarding apply.
    expect(tenantRuntimePartitionOf(repoRelative(tenantPath))).toMatchObject({
      key: 'delegation_idempotency',
      tier: 'confidential',
      tenant: 'acme',
    });
    const systemPath = repoRelative(delegationReservationPathForTests(idempotencyKey));
    expect(systemPath).toMatch(/^active\/shared\/runtime\/delegation-idempotency\/system\//u);
    expect(tenantRuntimePartitionOf(systemPath)).toBeUndefined();
  });

  it('fails closed on an unreadable reservation', async () => {
    const idempotencyKey = freshKey();
    safeWriteFile(delegationReservationPathForTests(idempotencyKey), '{not json', { mkdir: true });
    const execute = vi.fn(async () => 'must not run');
    await expect(
      runIdempotentDelegation({ instruction: 'x', options: { idempotencyKey }, execute })
    ).rejects.toThrow('[DELEGATION_RESERVATION_UNREADABLE]');
    expect(execute).not.toHaveBeenCalled();
  });
});

function seedInFlight(idempotencyKey: string, owner: Record<string, unknown>): void {
  const record = {
    kind: 'delegation_reservation',
    idempotency_key: idempotencyKey,
    payload_hash: computeDelegationPayloadHash({ instruction: 'x', options: { idempotencyKey } }),
    status: 'in_flight',
    reserved_at: owner.started_at,
    ...owner,
  };
  safeWriteFile(delegationReservationPathForTests(idempotencyKey), JSON.stringify(record), {
    mkdir: true,
  });
}
