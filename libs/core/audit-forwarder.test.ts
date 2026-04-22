import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChainAuditForwarder,
  getAuditForwarder,
  registerAuditForwarder,
  resetAuditForwarder,
  stubAuditForwarder,
  type AuditForwarder,
} from './audit-forwarder.js';
import type { AuditEntry } from './audit-chain.js';

const sample: AuditEntry = {
  id: 'AUD-SAMPLE-1',
  timestamp: '2026-04-21T00:00:00Z',
  agentId: 'test',
  action: 'policy_evaluation',
  operation: 'write_file',
  result: 'allowed',
  previousHash: '0'.repeat(64),
  currentHash: 'abc',
};

describe('audit-forwarder', () => {
  afterEach(() => resetAuditForwarder());

  it('defaults to the stub (no-op) forwarder', () => {
    expect(getAuditForwarder().name).toBe('stub');
  });

  it('stub publish is a no-op', () => {
    expect(() => stubAuditForwarder.publish(sample)).not.toThrow();
  });

  it('resolves a registered forwarder', async () => {
    const calls: AuditEntry[] = [];
    const fake: AuditForwarder = {
      name: 'fake',
      publish: (e) => {
        calls.push(e);
      },
    };
    registerAuditForwarder(fake);
    await getAuditForwarder().publish(sample);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('AUD-SAMPLE-1');
  });

  it('ChainAuditForwarder fans out to every member even when one fails', async () => {
    const calls: string[] = [];
    const flaky: AuditForwarder = {
      name: 'flaky',
      publish: () => {
        throw new Error('boom');
      },
    };
    const ok: AuditForwarder = {
      name: 'ok',
      publish: () => {
        calls.push('ok');
      },
    };
    const chain = new ChainAuditForwarder([flaky, ok]);
    await chain.publish(sample);
    expect(calls).toEqual(['ok']);
    expect(chain.name).toContain('flaky→ok');
  });
});
