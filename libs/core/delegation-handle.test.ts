import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeRmSync } from './secure-io.js';
import { createDelegationHandle, type DelegationHandle } from './delegated-task-observability.js';
import { buildRoleAwareReasoningBackend, stubReasoningBackend } from './reasoning-backend.js';

describe('delegation handles', () => {
  let tracePath: string;
  let storeDir: string;

  beforeEach(() => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    tracePath = `active/shared/tmp/delegation-handle-${suffix}.jsonl`;
    storeDir = `active/shared/tmp/delegation-handle-${suffix}`;
    process.env.KYBERION_DELEGATION_TRACE_PATH = tracePath;
    process.env.KYBERION_DELEGATION_STORE_DIR = storeDir;
  });

  afterEach(() => {
    delete process.env.KYBERION_DELEGATION_TRACE_PATH;
    delete process.env.KYBERION_DELEGATION_STORE_DIR;
    safeRmSync(tracePath);
    safeRmSync(storeDir);
  });

  it('joins and exposes a durable terminal status', async () => {
    const handle = createDelegationHandle({
      owner: 'test-worker',
      instruction: 'return a result',
      execute: async () => 'done',
    });
    await expect(handle.join()).resolves.toBe('done');
    expect(handle.status().status).toBe('completed');
    expect(handle.status().delegation_id).toBe(handle.delegation_id);
  });

  it('cancels a running handle and rejects join without changing legacy backend calls', async () => {
    let resolveTask!: (value: string) => void;
    const task = new Promise<string>((resolve) => {
      resolveTask = resolve;
    });
    const handle: DelegationHandle = createDelegationHandle({
      owner: 'test-worker',
      instruction: 'long task',
      execute: () => task,
    });
    await handle.cancel('operator stopped it');
    expect(handle.status().status).toBe('cancelled');
    await expect(handle.join()).rejects.toThrow(/DELEGATION_CANCELLED/);
    resolveTask('late result');
  });

  it('is available on role-aware backends', async () => {
    const backend = buildRoleAwareReasoningBackend(stubReasoningBackend);
    const handle = backend.delegateTaskHandle!('hello');
    await expect(handle.join()).resolves.toContain('[STUB]');
    expect(handle.status().status).toBe('completed');
  });
});
