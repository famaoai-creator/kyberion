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
  runStartReportingDelegation,
} from '../workforce/delegation-result.js';
import {
  deriveDelegationIdempotencyKey,
  loadDelegationReservation,
  resetDelegationIdempotencyForTests,
} from '../workforce/delegation-idempotency.js';

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

  it('with a key, fails over only on a structural pre-start proof', async () => {
    const preStart = chain(
      async () => {
        throw Object.assign(new Error('spawn claude ENOENT'), {
          code: 'ENOENT',
          syscall: 'spawn claude',
        });
      },
      async () => LONG
    );
    const keyA = deriveDelegationIdempotencyKey({ workItemId: `w-${randomUUID()}`, attempt: 1 });
    await expect(
      run(() => preStart.delegateTask('task', undefined, { idempotencyKey: keyA }))
    ).resolves.toBe(LONG);

    clearProviderHealth();
    // An auth-looking message proves nothing: agentic CLIs print it after tools ran.
    const authFallback = vi.fn(async () => LONG);
    const authMessage = chain(async () => {
      throw new Error('401 unauthorized: login required');
    }, authFallback);
    const keyAuth = deriveDelegationIdempotencyKey({ workItemId: `w-${randomUUID()}`, attempt: 1 });
    await expect(
      run(() => authMessage.delegateTask('task', undefined, { idempotencyKey: keyAuth }))
    ).rejects.toThrow('[execution-started]');
    expect(authFallback).not.toHaveBeenCalled();

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

  it('fails over a keyed delegation whose start-reporting backend failed before dispatch', async () => {
    // A start-reporting backend (API completion, governed CLI spawn) that got
    // a 429 before any child/tool ran proves "not started": no at-most-once lockout.
    const primary = vi.fn(() =>
      runStartReportingDelegation(async () => {
        throw Object.assign(new Error('429 rate limit exceeded'), { status: 429 });
      })
    );
    const fallback = vi.fn(async () => LONG);
    const target = chain(primary, fallback);
    const idempotencyKey = deriveDelegationIdempotencyKey({
      workItemId: `w-${randomUUID()}`,
      attempt: 1,
    });
    await expect(
      run(() => target.delegateTask('task', undefined, { idempotencyKey }))
    ).resolves.toBe(LONG);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(loadDelegationReservation(idempotencyKey)).toMatchObject({
      status: 'terminal',
      result: { status: 'completed' },
    });

    // The same backend once its child/tool ran: started, never re-run elsewhere.
    clearProviderHealth();
    const startedFallback = vi.fn(async () => LONG);
    const started = chain(
      () =>
        runStartReportingDelegation(async () => {
          markDelegationExecutionStarted();
          throw new Error('503 service temporarily unavailable');
        }),
      startedFallback
    );
    const keyStarted = deriveDelegationIdempotencyKey({
      workItemId: `w-${randomUUID()}`,
      attempt: 1,
    });
    await expect(
      run(() => started.delegateTask('task', undefined, { idempotencyKey: keyStarted }))
    ).rejects.toThrow('[execution-started]');
    expect(startedFallback).not.toHaveBeenCalled();
  });
});
