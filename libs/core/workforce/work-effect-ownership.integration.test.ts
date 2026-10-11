import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  claimWorkItem,
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  releaseWorkItem,
  clearWorkCoordinationStore,
  clearWorkCoordinationNamespace,
  setWorkCoordinationNamespace,
} from './work-coordination.js';
import { workEffectOwnership } from './work-effect-ownership.js';
import type { WorkItem } from './work-coordination-types.js';
beforeEach(() => {
  setWorkCoordinationNamespace('effect-ownership-regression');
  clearWorkCoordinationStore();
});
afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});
function create(id: string, tenant?: string) {
  return createWorkItem({
    itemId: id,
    title: id,
    description: 'isolated',
    status: 'ready',
    ...(tenant ? { context: { tenant_slug: tenant } } : {}),
    metadata: { dot_id: id, target: 'service:shared' },
  });
}
const claim = (id: string) =>
  claimWorkItem({
    itemId: id,
    actorPeerId: 'dot:' + id,
    purpose: 'isolated',
    requireNewLease: true,
  });
describe('durable effect ownership mutations', () => {
  it('ordinary archive and metadata replacement retain original target and block own reclaim', () => {
    create('a');
    create('b');
    claim('a');
    updateWorkItem({
      itemId: 'a',
      status: 'archived',
      metadata: { dot_id: 'a', target: 'service:changed' },
    });
    expect(getWorkItem('a')?.effect_ownership).toMatchObject({
      target: 'service:shared',
      state: 'held',
    });
    expect(() => claim('b')).toThrow(/ownership/);
    updateWorkItem({ itemId: 'a', status: 'ready' });
    expect(() => claim('a')).toThrow(/ownership/);
  });
  it('validates completion disposition before changing the active lease', () => {
    create('a');
    create('b');
    const owned = claim('a');
    const input = { itemId: 'a', leaseId: owned.lease.lease_id, actorPeerId: 'dot:a' };
    expect(() =>
      releaseWorkItem({ ...input, nextStatus: 'archived', effectDisposition: 'completed' })
    ).toThrow(/settlement/);
    expect(getWorkItem('a')?.lease_id).toBe(owned.lease.lease_id);
    expect(() => claim('b')).toThrow(/ownership/);
    releaseWorkItem({ ...input, nextStatus: 'done', effectDisposition: 'completed' });
    expect(getWorkItem('a')?.effect_ownership?.state).toBe('settled');
    expect(claim('b').item.status).toBe('in_progress');
  });
  it('never accepts a stale owner or duplicate execution claim', () => {
    create('a');
    const first = claim('a');
    expect(() => claim('a')).toThrow();
    expect(() =>
      releaseWorkItem({
        itemId: 'a',
        leaseId: first.lease.lease_id,
        actorPeerId: 'dot:other',
        nextStatus: 'done',
        effectDisposition: 'completed',
      })
    ).toThrow(/owner/);
    expect(getWorkItem('a')?.effect_ownership?.state).toBe('held');
    expect(getWorkItem('a')?.attempts).toHaveLength(1);
  });
  it.each([
    null,
    false,
    0,
    '',
    {},
    { state: 'settled', target: 'x', attempt_id: 'a', actor_id: 'dot:a' },
  ])('fails closed for explicit malformed ownership %j', (value) => {
    expect(() => workEffectOwnership({ effect_ownership: value } as unknown as WorkItem)).toThrow(
      /invalid stored effect/
    );
  });
  it('does not confuse tenantless ownership with tenant ownership', () => {
    create('a');
    claim('a');
    create('b', 'synthetic-tenant');
    expect(claim('b').item.status).toBe('in_progress');
  });
});
