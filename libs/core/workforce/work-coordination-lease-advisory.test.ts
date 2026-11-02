import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  setWorkCoordinationNamespace,
} from './work-coordination.js';
import { createMissionLeaseManager } from '../mission/mission-lease.js';

// W4: the claim path consults an *injected* MissionLeaseManager as a pure
// advisory — suspended contenders are reported on the result without
// changing claim acceptance or the WorkLease fence mechanics. No manager →
// no consult → identical result shape as before.

describe('claimWorkItem — lease advisory consult (W4)', () => {
  beforeEach(() => {
    setWorkCoordinationNamespace('work-coordination-lease-advisory-test');
    clearWorkCoordinationStore();
  });

  afterEach(() => {
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
  });

  it('reports a suspended contender without blocking the claim', () => {
    const item = createWorkItem({ title: 'contended', description: 'two peers want it' });
    const manager = createMissionLeaseManager();
    // peer-owner wins the mission lease; peer-b loses and is registered as a
    // suspended contender on the resource.
    const owner = manager.acquireLease({
      resource: item.item_id,
      holder: 'peer-owner',
      ttlMs: 60_000,
      now: 1_000,
    });
    expect(owner.ok).toBe(true);
    const contender = manager.acquireLease({
      resource: item.item_id,
      holder: 'peer-b',
      ttlMs: 60_000,
      now: 1_100,
    });
    expect(contender.ok).toBe(false);
    expect(contender.issues[0]?.code).toBe('LEASE_SUSPENDED');

    const claimed = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: 'peer-b',
      purpose: 'advised claim',
      leaseAdvisory: { manager, now: 1_200 },
    });

    // Advisory present and verdict carried — but the WorkLease claim itself
    // succeeded; the consult never replaces coordination mechanics.
    expect(claimed.item.item_id).toBe(item.item_id);
    expect(claimed.lease.holder_peer_id).toBe('peer-b');
    expect(claimed.advisory).toEqual({
      consulted: true,
      resource: item.item_id,
      holder: 'peer-b',
      suspended: true,
      status: 'suspended',
      blocking_holder: 'peer-owner',
    });
  });

  it('reports a clear verdict for a non-suspended claimant', () => {
    const item = createWorkItem({ title: 'uncontended', description: 'nobody else wants it' });
    const manager = createMissionLeaseManager();
    manager.acquireLease({
      resource: 'a-different-resource',
      holder: 'peer-owner',
      ttlMs: 60_000,
      now: 1_000,
    });

    const claimed = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: 'peer-b',
      purpose: 'advised claim',
      leaseAdvisory: { manager, now: 1_200 },
    });

    expect(claimed.lease.holder_peer_id).toBe('peer-b');
    expect(claimed.advisory).toEqual({
      consulted: true,
      resource: item.item_id,
      holder: 'peer-b',
      suspended: false,
      status: 'clear',
    });
    expect(claimed.advisory?.blocking_holder).toBeUndefined();
  });

  it('does not consult when no manager is supplied', () => {
    const item = createWorkItem({ title: 'plain', description: 'no advisory requested' });
    const claimed = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: 'peer-b',
      purpose: 'plain claim',
    });
    expect(claimed.lease.holder_peer_id).toBe('peer-b');
    expect(claimed.advisory).toBeUndefined();
  });

  it('defaults the consulted resource to the claimed work item id', () => {
    const item = createWorkItem({
      title: 'defaulted',
      description: 'resource defaults to item id',
    });
    const manager = createMissionLeaseManager();
    manager.acquireLease({
      resource: item.item_id,
      holder: 'peer-owner',
      ttlMs: 60_000,
      now: 1_000,
    });
    manager.acquireLease({
      resource: item.item_id,
      holder: 'peer-b',
      ttlMs: 60_000,
      now: 1_100,
    });
    const claimed = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: 'peer-b',
      purpose: 'advised claim',
      // no explicit resource — the item id is used
      leaseAdvisory: { manager, now: 1_200 },
    });
    expect(claimed.advisory?.resource).toBe(item.item_id);
    expect(claimed.advisory?.suspended).toBe(true);
  });

  it('an unsuspended verdict does not change claim success', () => {
    const item = createWorkItem({ title: 'verdict-neutral', description: 'claim still works' });
    const manager = createMissionLeaseManager();
    const claimed = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: 'peer-c',
      purpose: 'advised claim',
      leaseAdvisory: { manager, now: 1_200 },
    });
    expect(claimed.item.status).toBe('in_progress');
    expect(claimed.advisory?.suspended).toBe(false);
  });
});
