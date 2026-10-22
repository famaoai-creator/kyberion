import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContextAsync } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  createDelegationHandle,
  loadDelegatedTaskRecord,
  startDelegatedTaskTrace,
} from './delegated-task-observability.js';
import {
  buildRoleAwareReasoningBackend,
  getReasoningBackend,
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from './reasoning/reasoning-backend.js';
import {
  getActiveSandboxPolicy,
  withSandboxPolicy,
  type SandboxPolicy,
} from './shell/sandbox-policy.js';
import { runInResourceAccessScope } from './foundation/resource-access-scope.js';

const relativeRoot = `active/shared/tmp/delegation-host-io-${process.pid}`;
const root = pathResolver.rootResolve(relativeRoot);
const tracePath = pathResolver.rootResolve(`${relativeRoot}/traces/audit.jsonl`);
const forbiddenPath = pathResolver.rootResolve(`${relativeRoot}/model-write.txt`);
const readonly: SandboxPolicy = {
  mode: 'read-only',
  networkAccess: true,
  networkAllowlist: ['localhost'],
  provider: 'kyberion',
  enforcement: 'full',
  enforcement_reason: 'advisory regression',
};
const governed = <T>(fn: () => Promise<T>) =>
  withExecutionContextAsync(
    'organization_operator',
    () => withSandboxPolicy(readonly, fn),
    undefined,
    'delegation-host-test'
  );

describe('host delegation bookkeeping inside advisory sandbox', () => {
  beforeEach(() => {
    process.env.KYBERION_DELEGATION_TRACE_PATH = `${relativeRoot}/traces/audit.jsonl`;
    process.env.KYBERION_DELEGATION_STORE_DIR = `${relativeRoot}/records`;
    safeRmSync(root, { recursive: true, force: true });
  });
  afterEach(() => {
    resetReasoningBackend();
    safeRmSync(root, { recursive: true, force: true });
    delete process.env.KYBERION_DELEGATION_TRACE_PATH;
    delete process.env.KYBERION_DELEGATION_STORE_DIR;
  });

  it('real backend handle persists started/completed host records while provider remains read-only', async () => {
    registerReasoningBackend(
      buildRoleAwareReasoningBackend(
        {
          ...stubReasoningBackend,
          name: 'claude-cli',
          delegateTaskHandle: undefined,
          delegateTask: async () => {
            expect(getActiveSandboxPolicy()).toEqual(readonly);
            expect(() => safeWriteFile(forbiddenPath, 'provider effect')).toThrow(
              'SANDBOX_WRITE_DENIED'
            );
            return 'planner result';
          },
        },
        new Map()
      )
    );
    await governed(async () => {
      const handle = getReasoningBackend().delegateTaskHandle!('plan only', undefined, {
        advisory: true,
        profile: 'planner',
      });
      expect(loadDelegatedTaskRecord(handle.delegation_id)?.status).toBe('started');
      await expect(handle.join()).resolves.toBe('planner result');
      expect(loadDelegatedTaskRecord(handle.delegation_id)?.status).toBe('completed');
      expect(getActiveSandboxPolicy()).toEqual(readonly);
      expect(() => safeWriteFile(forbiddenPath, 'after completion')).toThrow(
        'SANDBOX_WRITE_DENIED'
      );
    });
    const events = String(safeReadFile(tracePath, { encoding: 'utf8' }))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.status)).toEqual(['started', 'completed']);
    expect(safeExistsSync(forbiddenPath)).toBe(false);
  });

  it('provider failure is durably recorded without relaxing the next operation', async () => {
    registerReasoningBackend(
      buildRoleAwareReasoningBackend(
        {
          ...stubReasoningBackend,
          name: 'claude-cli',
          delegateTaskHandle: undefined,
          delegateTask: async () => {
            throw new Error('provider rejected');
          },
        },
        new Map()
      )
    );
    await governed(async () => {
      const handle = getReasoningBackend().delegateTaskHandle!('plan only');
      await expect(handle.join()).rejects.toThrow('provider rejected');
      expect(loadDelegatedTaskRecord(handle.delegation_id)?.status).toBe('failed');
      expect(getActiveSandboxPolicy()).toEqual(readonly);
    });
  });

  it('cancel callback stays read-only but host cancellation is recorded', async () => {
    await governed(async () => {
      const handle = createDelegationHandle({
        instruction: 'waiting',
        execute: () => new Promise(() => {}),
        cancel: () => {
          expect(getActiveSandboxPolicy()).toEqual(readonly);
          expect(() => safeWriteFile(forbiddenPath, 'cancel effect')).toThrow(
            'SANDBOX_WRITE_DENIED'
          );
        },
      });
      await handle.cancel();
      expect(loadDelegatedTaskRecord(handle.delegation_id)?.status).toBe('cancelled');
      await expect(handle.join()).rejects.toThrow('DELEGATION_CANCELLED');
    });
  });

  it('serializes untrusted values before entering the host write exception', async () => {
    await governed(async () => {
      const instruction = {
        toJSON() {
          expect(getActiveSandboxPolicy()).toEqual(readonly);
          safeWriteFile(forbiddenPath, 'serialization effect');
          return 'bad';
        },
      };
      expect(() =>
        startDelegatedTaskTrace({ owner: 'test', instruction: instruction as unknown as string })
      ).toThrow('SANDBOX_WRITE_DENIED');
    });
    expect(safeExistsSync(forbiddenPath)).toBe(false);
  });

  it('records unbound host bookkeeping while preserving the readonly caller', () => {
    withSandboxPolicy(readonly, () => {
      const trace = startDelegatedTaskTrace({ owner: 'test', instruction: 'tenantless' });
      expect(trace).toBeDefined();
      expect(getActiveSandboxPolicy()).toEqual(readonly);
      expect(() => safeWriteFile(forbiddenPath, 'provider effect')).toThrow('SANDBOX_WRITE_DENIED');
    });
  });

  it('retains the parent resource ceiling and restores readonly after a denied host write', async () => {
    await governed(async () => {
      runInResourceAccessScope(
        { tenantSlug: 'delegation-host-test', readExact: [], writeExact: [], mkdirExact: [] },
        () => {
          expect(() =>
            startDelegatedTaskTrace({ owner: 'test', instruction: 'denied by outer capability' })
          ).toThrow('RESOURCE_SCOPE_DENIED');
          expect(getActiveSandboxPolicy()).toEqual(readonly);
        }
      );
      expect(() => safeWriteFile(forbiddenPath, 'after denial')).toThrow('SANDBOX_WRITE_DENIED');
    });
  });
});
