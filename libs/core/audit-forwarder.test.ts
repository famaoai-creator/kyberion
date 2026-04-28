import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChainAuditForwarder,
  TenantFilteringAuditForwarder,
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

  describe('TenantFilteringAuditForwarder (IP-2)', () => {
    it('passes entries whose tenantSlug matches the allowed list', async () => {
      const seen: string[] = [];
      const sink: AuditForwarder = {
        name: 'sink',
        publish: (e) => { seen.push(e.id); },
      };
      const filter = new TenantFilteringAuditForwarder(sink, ['acme-corp']);
      await filter.publish({ ...sample, id: 'A1', tenantSlug: 'acme-corp' });
      await filter.publish({ ...sample, id: 'A2', tenantSlug: 'other-tenant' });
      await filter.publish({ ...sample, id: 'A3' });
      expect(seen).toEqual(['A1']);
    });

    it('passes tenantless entries when passThroughTenantless=true', async () => {
      const seen: string[] = [];
      const sink: AuditForwarder = {
        name: 'sink',
        publish: (e) => { seen.push(e.id); },
      };
      const filter = new TenantFilteringAuditForwarder(sink, ['acme-corp'], true);
      await filter.publish({ ...sample, id: 'B1' });
      await filter.publish({ ...sample, id: 'B2', tenantSlug: 'acme-corp' });
      await filter.publish({ ...sample, id: 'B3', tenantSlug: 'other-tenant' });
      expect(seen).toEqual(['B1', 'B2']);
    });

    it('exposes a name reflecting the configured tenants', () => {
      const filter = new TenantFilteringAuditForwarder(stubAuditForwarder, ['acme-corp', 'beta']);
      expect(filter.name).toContain('acme-corp');
      expect(filter.name).toContain('beta');
      expect(filter.name).toContain('stub');
    });
  });
});
