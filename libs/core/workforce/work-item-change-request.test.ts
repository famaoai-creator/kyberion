import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  listCoordinationEvents,
  releaseWorkItem,
  setWorkCoordinationNamespace,
  updateWorkItem,
} from './work-coordination.js';
import {
  linkWorkItemChangeRequest,
  listChangeRequestLinks,
  normalizeChangeRequestBranch,
  readWorkItemChangeRequest,
  resolveChangeRequestOwner,
  updateWorkItemChangeRequest,
} from './work-item-change-request.js';

beforeEach(() => {
  setWorkCoordinationNamespace('work-item-change-request-test');
  clearWorkCoordinationStore();
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

function claimedItem(itemId: string, peer: string) {
  createWorkItem({ itemId, title: itemId, description: 'change request fixture' });
  return claimWorkItem({ itemId, actorPeerId: peer, purpose: 'implementation' });
}

describe('work item change request', () => {
  it('links a branch to the claimed item and resolves its owner without any forge call', () => {
    const { lease } = claimedItem('WI-A', 'peer:claude');
    const item = linkWorkItemChangeRequest({
      itemId: 'WI-A',
      actorPeerId: 'peer:claude',
      branch: 'refs/heads/feat/a',
      forge: 'gitlab',
      ref: '!42',
      baseBranch: 'main',
    });
    expect(readWorkItemChangeRequest(item)).toMatchObject({
      branch: 'feat/a',
      forge: 'gitlab',
      ref: '!42',
      base_branch: 'main',
      state: 'open',
      linked_by_peer_id: 'peer:claude',
    });

    for (const query of [{ branch: 'feat/a' }, { forge: 'gitlab', ref: '!42' }]) {
      const resolved = resolveChangeRequestOwner(query)!;
      expect(resolved.item.item_id).toBe('WI-A');
      expect(resolved.owner).toMatchObject({ peer_id: 'peer:claude', lease_id: lease.lease_id });
    }
    expect(resolveChangeRequestOwner({ forge: 'github', ref: '!42' })).toBeNull();
    expect(listCoordinationEvents({ event_type: 'change_request_linked' })).toHaveLength(1);
  });

  it('only lets the live claim holder link', () => {
    createWorkItem({ itemId: 'WI-U', title: 'unclaimed', description: 'x' });
    expect(() =>
      linkWorkItemChangeRequest({ itemId: 'WI-U', actorPeerId: 'peer:a', branch: 'feat/u' })
    ).toThrow(/does not hold the claim/);

    claimedItem('WI-B', 'peer:codex');
    expect(() =>
      linkWorkItemChangeRequest({ itemId: 'WI-B', actorPeerId: 'peer:devin', branch: 'feat/b' })
    ).toThrow(/peer:devin does not hold the claim/);
  });

  it('keeps one unfinished item per branch, and frees the branch once the item is done', () => {
    claimedItem('WI-1', 'peer:a');
    linkWorkItemChangeRequest({ itemId: 'WI-1', actorPeerId: 'peer:a', branch: 'feat/shared' });
    claimedItem('WI-2', 'peer:b');
    expect(() =>
      linkWorkItemChangeRequest({ itemId: 'WI-2', actorPeerId: 'peer:b', branch: 'feat/shared' })
    ).toThrow(/already linked to WI-1/);

    updateWorkItem({ itemId: 'WI-1', status: 'done' });
    linkWorkItemChangeRequest({ itemId: 'WI-2', actorPeerId: 'peer:b', branch: 'feat/shared' });
    // The unfinished item wins over the finished one that used the branch earlier.
    expect(resolveChangeRequestOwner({ branch: 'feat/shared' })!.item.item_id).toBe('WI-2');
  });

  it('relinking the same branch keeps its state and forge identity', () => {
    claimedItem('WI-R', 'peer:a');
    const first = linkWorkItemChangeRequest({
      itemId: 'WI-R',
      actorPeerId: 'peer:a',
      branch: 'feat/r',
      forge: 'gerrit',
      ref: 'I3f2c',
    });
    const again = linkWorkItemChangeRequest({
      itemId: 'WI-R',
      actorPeerId: 'peer:a',
      branch: 'feat/r',
      headSha: 'abc123',
    });
    expect(readWorkItemChangeRequest(again)).toMatchObject({
      forge: 'gerrit',
      ref: 'I3f2c',
      head_sha: 'abc123',
      linked_at: readWorkItemChangeRequest(first)!.linked_at,
    });
  });

  it('records forge observations: holder-only while claimed, any observer after release', () => {
    const { lease } = claimedItem('WI-M', 'peer:a');
    linkWorkItemChangeRequest({ itemId: 'WI-M', actorPeerId: 'peer:a', branch: 'feat/m' });
    expect(() =>
      updateWorkItemChangeRequest({ itemId: 'WI-M', actorPeerId: 'peer:b', headSha: 'f00' })
    ).toThrow(/claimed by peer:a/);

    releaseWorkItem({ itemId: 'WI-M', leaseId: lease.lease_id, actorPeerId: 'peer:a' });
    const merged = updateWorkItemChangeRequest({
      itemId: 'WI-M',
      actorPeerId: 'peer:ci-observer',
      state: 'merged',
      headSha: 'f00',
    });
    expect(readWorkItemChangeRequest(merged)).toMatchObject({ state: 'merged', head_sha: 'f00' });
    expect(resolveChangeRequestOwner({ branch: 'feat/m' })!.owner).toBeNull();
    expect(listChangeRequestLinks({ state: 'merged' }).map((link) => link.item.item_id)).toEqual([
      'WI-M',
    ]);
    expect(listChangeRequestLinks({ state: 'open' })).toEqual([]);
  });

  it('keeps unrelated metadata when linking', () => {
    createWorkItem({ itemId: 'WI-K', title: 'k', description: 'x', metadata: { keep: 1 } });
    claimWorkItem({ itemId: 'WI-K', actorPeerId: 'peer:a', purpose: 'implementation' });
    const item = linkWorkItemChangeRequest({
      itemId: 'WI-K',
      actorPeerId: 'peer:a',
      branch: 'feat/k',
    });
    expect(item.metadata).toMatchObject({ keep: 1 });
  });

  it('rejects branch names git would reject', () => {
    for (const bad of ['', 'has space', 'a..b', '-lead', 'trail/', 'x.lock', 'a@{1}']) {
      expect(() => normalizeChangeRequestBranch(bad)).toThrow(/invalid branch name/);
    }
    expect(normalizeChangeRequestBranch(' refs/heads/fix/peer-1186 ')).toBe('fix/peer-1186');
  });
});
