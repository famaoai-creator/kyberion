import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeWriteFile } from '../secure-io.js';
import {
  auditChain,
  holdsAuditChainLock,
  registerAuditChainIo,
  withAuditChainLock,
  type AuditChainIo,
} from './audit-chain.js';
import { policyEngine } from './policy-engine.js';

// N1b: the audit chain lock is not reentrant. A write the locked section made
// that policy denied audited the denial with record(), which waited out the
// 5s lock on itself and surfaced as a lock timeout instead of the denial.

const TENANT = 'audit-lock-co';
const ENV_KEYS = ['KYBERION_PERSONA', 'MISSION_ROLE', 'KYBERION_SUDO', 'KYBERION_TENANT'] as const;

interface Append {
  file: string;
  action: string;
}

function fakeIo(appends: Append[], onAppend?: (file: string) => void): AuditChainIo {
  return {
    read: () => '',
    loadJson: <T>() => ({}) as T,
    exists: (file) => file.includes(`${path.sep}customer${path.sep}`),
    mkdir: () => undefined,
    readdir: () => [],
    append: (file, line) => {
      onAppend?.(file);
      appends.push({ file, action: JSON.parse(line).action });
    },
    assertSafePath: (file) => file,
  };
}

const masterActions = (appends: Append[]) =>
  appends.filter((append) => !append.file.includes(`${path.sep}customer${path.sep}`));

describe('audit chain lock', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  let restoreAuditIo: (() => void) | undefined;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    delete process.env.MISSION_ROLE;
    delete process.env.KYBERION_SUDO;
    delete process.env.KYBERION_TENANT;
    process.env.KYBERION_PERSONA = 'sovereign';
  });

  afterEach(() => {
    restoreAuditIo?.();
    restoreAuditIo = undefined;
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('refuses a plain record inside the lock at once instead of waiting on itself', () => {
    const appends: Append[] = [];
    restoreAuditIo = registerAuditChainIo(fakeIo(appends));
    const started = Date.now();
    expect(() =>
      withAuditChainLock(() =>
        auditChain.record({ agentId: 'a', action: 'inner', operation: 'x', result: 'completed' })
      )
    ).toThrow('[AUDIT_REENTRANT]');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(holdsAuditChainLock()).toBe(false);
    expect(appends).toEqual([]);
  });

  it('appends a deferrable record once the lock is released', () => {
    const appends: Append[] = [];
    restoreAuditIo = registerAuditChainIo(fakeIo(appends));
    const returned = withAuditChainLock(() => {
      const inner = auditChain.recordDeferrable({
        agentId: 'a',
        action: 'deferred',
        operation: 'x',
        result: 'failed',
      });
      expect(appends).toEqual([]);
      return inner;
    });
    expect(returned).toBeUndefined();
    expect(masterActions(appends).map((append) => append.action)).toEqual(['deferred']);
    // Outside the lock it records straight away.
    expect(
      auditChain.recordDeferrable({
        agentId: 'a',
        action: 'direct',
        operation: 'x',
        result: 'completed',
      })?.action
    ).toBe('direct');
  });

  it('records held entries in place and only inside the lock', () => {
    const appends: Append[] = [];
    restoreAuditIo = registerAuditChainIo(fakeIo(appends));
    expect(() =>
      auditChain.recordHeld({ agentId: 'a', action: 'held', operation: 'x', result: 'completed' })
    ).toThrow('[AUDIT_LOCK_NOT_HELD]');
    withAuditChainLock(() => {
      auditChain.recordHeld({ agentId: 'a', action: 'held', operation: 'x', result: 'completed' });
      expect(masterActions(appends).map((append) => append.action)).toEqual(['held']);
    });
  });

  it('surfaces a mirror write denial without a lock wait and audits it once', () => {
    const appends: Append[] = [];
    // A mirror write that policy denies, the way secure-io audits a denial.
    restoreAuditIo = registerAuditChainIo(
      fakeIo(appends, (file) => {
        if (!file.includes(`${path.sep}customer${path.sep}`)) return;
        auditChain.recordDeferrable({
          agentId: 'a',
          action: 'policy_violation',
          operation: 'file_write',
          result: 'failed',
        });
        throw new Error('[POLICY_BLOCKED] mirror write denied');
      })
    );
    const started = Date.now();
    auditChain.record({
      agentId: 'a',
      action: 'work.done',
      operation: 'x',
      result: 'completed',
      tenantSlug: TENANT,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    // The denial lands after the entry whose mirror write it refused; its own
    // mirror write is denied too, and that second denial is dropped, not looped.
    expect(masterActions(appends).map((append) => append.action)).toEqual([
      'work.done',
      'policy_violation',
    ]);
  });

  it('reports a policy-denied safeWriteFile under the lock as the denial', () => {
    const appends: Append[] = [];
    restoreAuditIo = registerAuditChainIo(fakeIo(appends));
    const evaluate = policyEngine.evaluate.bind(policyEngine);
    vi.spyOn(policyEngine, 'evaluate').mockImplementation((context) =>
      context.operation === 'file_write'
        ? { allowed: false, action: 'deny', message: 'n1b test denial' }
        : evaluate(context)
    );
    const target = path.join(pathResolver.sharedTmp('audit-chain-lock-test'), 'denied.txt');
    const started = Date.now();
    expect(() => withAuditChainLock(() => safeWriteFile(target, 'x'))).toThrow(
      /\[POLICY_BLOCKED\].*n1b test denial/
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(masterActions(appends).map((append) => append.action)).toEqual(['policy_violation']);
  });
});
