import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auditRecords = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../governance/audit-chain.js', () => ({
  auditChain: {
    record: (entry: Record<string, unknown>) => {
      auditRecords.push(entry);
      return entry;
    },
  },
}));

import { withExecutionContext } from '../authority.js';
import { safeReadFile, safeWriteFile } from '../secure-io.js';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  describeWorkCoordinationStore,
  expireWorkItemLeases,
  getWorkItem,
  releaseWorkItem,
  renewWorkItemLease,
  setWorkCoordinationNamespace,
} from './work-coordination.js';
import { isWorkLeaseLive } from './work-item-lease.js';

beforeEach(() => {
  auditRecords.splice(0);
  setWorkCoordinationNamespace('work-item-lease-' + randomUUID());
});
afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

describe('WorkItem claim as a work_item lease adapter (W3)', () => {
  it('fences every claim generation and audits acquire/renew/release/expire in one shape', () => {
    const item = createWorkItem({
      itemId: 'WI-W3',
      title: 'W3',
      description: 'W3 lease adapter',
      status: 'ready',
    });
    const first = claimWorkItem({ itemId: item.item_id, actorPeerId: 'peer-a', purpose: 'p' });
    expect(first.lease.fence).toBe(1);
    const renewed = renewWorkItemLease({ leaseId: first.lease.lease_id, actorPeerId: 'peer-a' });
    expect(renewed.fence).toBe(1);
    expect(() =>
      renewWorkItemLease({ leaseId: first.lease.lease_id, actorPeerId: 'peer-b' })
    ).toThrow(/holder mismatch/);
    releaseWorkItem({
      itemId: item.item_id,
      actorPeerId: 'peer-a',
      leaseId: first.lease.lease_id,
    });
    const second = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: 'peer-b',
      purpose: 'p',
      ttlMs: 1,
    });
    expect(second.lease.fence).toBe(2);
    const later = new Date(Date.now() + 60_000).toISOString();
    const expired = expireWorkItemLeases(later);
    expect(expired.map((lease) => lease.lease_id)).toEqual([second.lease.lease_id]);

    const leaseEvents = auditRecords.filter((entry) => String(entry.action).startsWith('lease.'));
    expect(leaseEvents.map((entry) => `${entry.action}:${entry.agentId}`)).toEqual([
      'lease.acquire:peer-a',
      'lease.renew:peer-a',
      'lease.release:peer-a',
      'lease.acquire:peer-b',
      'lease.expire:lease-reaper',
    ]);
    for (const entry of leaseEvents) {
      expect(entry.operation).toBe('work_item:WI-W3');
      expect(entry.metadata).toMatchObject({ resource_kind: 'work_item', resource_id: 'WI-W3' });
    }
  });

  it('reads pre-W3 leases (no fence) and advances past them', () => {
    const item = createWorkItem({
      itemId: 'WI-LEGACY',
      title: 'legacy',
      description: 'pre-W3 lease',
      status: 'ready',
    });
    const leasesPath = String(describeWorkCoordinationStore().leases_path);
    const legacy = {
      lease_id: 'wlease-legacy',
      item_id: item.item_id,
      holder_peer_id: 'peer-old',
      purpose: 'pre-W3',
      status: 'released',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      created_at: new Date().toISOString(),
      renewed_at: new Date().toISOString(),
      released_at: new Date().toISOString(),
    };
    const existing = (() => {
      try {
        return String(safeReadFile(leasesPath, { encoding: 'utf8' }));
      } catch {
        return '';
      }
    })();
    withExecutionContext('infrastructure_sentinel', () =>
      safeWriteFile(leasesPath, existing + JSON.stringify(legacy) + '\n', { mkdir: true })
    );
    // A released legacy lease never counts as live, whatever its expiry.
    expect(isWorkLeaseLive(legacy as never)).toBe(false);
    const claim = claimWorkItem({ itemId: item.item_id, actorPeerId: 'peer-new', purpose: 'p' });
    expect(claim.lease.fence).toBe(1);
    expect(getWorkItem(item.item_id)?.claimed_by_peer_id).toBe('peer-new');
  });
});
