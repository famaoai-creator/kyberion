import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFailoverReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
} from './reasoning-backend.js';
import { withReasoningPayloadScope } from './reasoning-egress-scope.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { clearProviderHealth } from '../provider/provider-health-registry.js';
import {
  buildFailedDelegationResult,
  markDelegationExecutionStarted,
} from '../delegation-result.js';
import {
  deriveDelegationIdempotencyKey,
  resetDelegationIdempotencyForTests,
} from '../delegation-idempotency.js';

const SCOPE = {
  tier: 'public' as const,
  purpose: 'hermetic delegation guard test',
  training_use: 'training_eligible' as const,
};
const LONG = 'A detailed report with concrete evidence. '.repeat(10);

function backend(name: string, delegateTask: ReasoningBackend['delegateTask']): ReasoningBackend {
  return { ...stubReasoningBackend, name, delegateTask };
}

function chain(
  primary: ReasoningBackend['delegateTask'],
  fallback: ReasoningBackend['delegateTask']
) {
  return buildFailoverReasoningBackend([
    { label: 'primary', provider: 'claude', backend: backend('primary', primary) },
    { label: 'fallback', provider: 'gemini', backend: backend('fallback', fallback) },
  ]);
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return withReasoningPayloadScope(SCOPE, fn);
}

describe('R5 delegation failover guard', () => {
  beforeEach(() => {
    process.env.KYBERION_REASONING_RETRY_BASE_MS = '0';
    clearProviderHealth();
    resetDelegationIdempotencyForTests();
  });
  afterEach(() => {
    delete process.env.KYBERION_REASONING_RETRY_BASE_MS;
    clearProviderHealth();
  });

  it('does not re-run a delegation on another candidate once execution started', async () => {
    const fallback = vi.fn(async () => LONG);
    const target = chain(async () => {
      markDelegationExecutionStarted();
      throw new Error('503 service temporarily unavailable');
    }, fallback);
    const error = await run(() => target.delegateTask('edit files')).catch((e: unknown) => e);
    expect(fallback).not.toHaveBeenCalled();
    expect(String(error)).toContain('[execution-started]');
    const result = buildFailedDelegationResult(error);
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ class: 'transient', allowFailover: false });
  });

  it('does not retry in place once execution started', async () => {
    const primary = vi.fn(async () => {
      markDelegationExecutionStarted();
      throw new Error('429 rate limit');
    });
    const target = chain(primary, async () => LONG);
    await expect(run(() => target.delegateTask('edit files'))).rejects.toThrow();
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it('still fails over on an unknown failure without a key (legacy behavior)', async () => {
    const target = chain(
      async () => {
        throw new Error('provider unavailable');
      },
      async () => LONG
    );
    await expect(run(() => target.delegateTask('task'))).resolves.toBe(LONG);
  });

  it('with a key, fails over only on provably pre-start failures', async () => {
    const preStart = chain(
      async () => {
        throw new Error('401 unauthorized: login required');
      },
      async () => LONG
    );
    const keyA = deriveDelegationIdempotencyKey({ workItemId: `w-${randomUUID()}`, attempt: 1 });
    await expect(
      run(() => preStart.delegateTask('task', undefined, { idempotencyKey: keyA }))
    ).resolves.toBe(LONG);

    // The auth failure demoted the primary provider; start the next case clean.
    clearProviderHealth();
    const fallback = vi.fn(async () => LONG);
    const unknown = chain(async () => {
      throw new Error('provider crashed mid-run');
    }, fallback);
    const keyB = deriveDelegationIdempotencyKey({ workItemId: `w-${randomUUID()}`, attempt: 1 });
    await expect(
      run(() => unknown.delegateTask('task', undefined, { idempotencyKey: keyB }))
    ).rejects.toThrow('[execution-started]');
    expect(fallback).not.toHaveBeenCalled();
    // A replay with the same key returns the recorded failure; nothing re-runs.
    await expect(
      run(() => unknown.delegateTask('task', undefined, { idempotencyKey: keyB }))
    ).rejects.toThrow();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('replays a completed keyed delegation without calling the backend again', async () => {
    const primary = vi.fn(async () => LONG);
    const target = chain(primary, async () => 'unused');
    const idempotencyKey = deriveDelegationIdempotencyKey({
      workItemId: `w-${randomUUID()}`,
      attempt: 3,
    });
    await expect(run(() => target.delegateTask('task', 'ctx', { idempotencyKey }))).resolves.toBe(
      LONG
    );
    await expect(run(() => target.delegateTask('task', 'ctx', { idempotencyKey }))).resolves.toBe(
      LONG
    );
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it('exposes a structured result through delegateTaskHandle().joinResult()', async () => {
    process.env.KYBERION_DELEGATION_STORE_DIR = `active/shared/tmp/r5-guard-tests/delegations-${process.pid}`;
    process.env.KYBERION_DELEGATION_TRACE_PATH = `active/shared/tmp/r5-guard-tests/trace-${process.pid}.jsonl`;
    const target = chain(
      async () => LONG,
      async () => 'unused'
    );
    const handle = await run(async () => target.delegateTaskHandle!('task'));
    await expect(run(() => handle.joinResult())).resolves.toMatchObject({
      status: 'completed',
      output_text: LONG,
      usage: null,
      artifacts: [],
    });
    expect(handle.status().outcome).toMatchObject({ status: 'completed', usage: null });
    const dir = pathResolver.rootResolve('active/shared/tmp/r5-guard-tests');
    if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    delete process.env.KYBERION_DELEGATION_STORE_DIR;
    delete process.env.KYBERION_DELEGATION_TRACE_PATH;
  });
});
