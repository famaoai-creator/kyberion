import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import {
  assertUndispatchedWorkItemEvidenceHeld,
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  describeWorkCoordinationStore,
  readUndispatchedWorkItemEvidence,
  releaseWorkItem,
  setWorkCoordinationNamespace,
  withUndispatchedWorkItemEvidence,
} from './work-coordination.js';

const selector = {
  workItemId: 'WI-FD-' + 'a'.repeat(48),
  actionRef: 'frontdesk-recovery-action',
  approvalRequestId: 'approval-recovery',
  binding: {
    request_id: '00000000-0000-4000-8000-000000000002',
    work_item_id: 'WI-FD-' + 'a'.repeat(48),
  },
};
let files: Record<string, string>;
let unrelated: ReturnType<typeof createWorkItem>;
const write = (key: string, text: string) =>
  withExecutionContext('infrastructure_sentinel', () => safeWriteFile(files[key], text));
const append = (key: string, row: unknown) =>
  write(key, safeReadFile(files[key], 'utf8') + JSON.stringify(row) + '\n');
beforeEach(() => {
  setWorkCoordinationNamespace('recovery-proof-' + randomUUID());
  unrelated = createWorkItem({
    itemId: 'unrelated',
    title: 'Unrelated work',
    description: 'Retained governed fixture',
    status: 'ready',
  });
  const claim = claimWorkItem({
    itemId: unrelated.item_id,
    actorPeerId: 'fixture',
    purpose: 'Fixture',
  });
  releaseWorkItem({
    itemId: unrelated.item_id,
    actorPeerId: 'fixture',
    leaseId: claim.lease.lease_id,
    nextStatus: 'done',
  });
  const store = describeWorkCoordinationStore();
  files = Object.fromEntries(
    ['items_path', 'leases_path', 'events_path'].map((key) => [key, String(store[key])])
  );
});
afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  vi.restoreAllMocks();
});

describe('strict undispatched retained coordination evidence', () => {
  it('reads a complete unrelated history without mutations and grants only a bounded callback proof', () => {
    const before = Object.values(files).map((file) => safeReadFile(file, 'utf8'));
    expect(readUndispatchedWorkItemEvidence(selector)).toMatchObject({
      ok: true,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.values(files).map((file) => safeReadFile(file, 'utf8'))).toEqual(before);
    expect(() => assertUndispatchedWorkItemEvidenceHeld(selector.binding)).toThrow();
    expect(
      withUndispatchedWorkItemEvidence(selector, () => {
        assertUndispatchedWorkItemEvidenceHeld(selector.binding);
        return 'commit';
      })
    ).toBe('commit');
    expect(() => assertUndispatchedWorkItemEvidenceHeld(selector.binding)).toThrow();
  });
  it('rejects malformed selectors before attempting canonical path resolution', () => {
    expect(
      readUndispatchedWorkItemEvidence(
        { ...selector, actionRef: '' },
        {
          rootDir: '/not-a-repository-evidence-root',
        }
      )
    ).toEqual({ ok: false, reason: 'invalid_evidence_selector' });
  });
  it('binds callback proof to the exact request, work item, action, and approval', () => {
    withUndispatchedWorkItemEvidence(selector, () => {
      expect(() =>
        assertUndispatchedWorkItemEvidenceHeld(selector.binding, {
          actionRef: selector.actionRef,
          approvalRequestId: selector.approvalRequestId,
        })
      ).not.toThrow();
      for (const links of [
        { actionRef: 'different-action', approvalRequestId: selector.approvalRequestId },
        { actionRef: selector.actionRef, approvalRequestId: 'different-approval' },
      ])
        expect(() => assertUndispatchedWorkItemEvidenceHeld(selector.binding, links)).toThrow();
      for (const binding of [
        { ...selector.binding, request_id: 'different-request' },
        { ...selector.binding, work_item_id: 'different-item' },
      ])
        expect(() => assertUndispatchedWorkItemEvidenceHeld(binding)).toThrow();
    });
  });
  it('returns only a digest even when unrelated actor data exists in retained history', () => {
    append('events_path', {
      event_id: 'private-actor-event',
      ts: new Date().toISOString(),
      event_type: 'item_attempt_started',
      actor_peer_id: 'private-peer',
      actor_user_id: 'private-user',
      payload: { actor: { user_id: 'private-nested-user' } },
    });
    expect(readUndispatchedWorkItemEvidence(selector)).toEqual({
      ok: true,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it.each(['items_path', 'leases_path', 'events_path'])(
    'rejects a missing %s without initializing it',
    (key) => {
      withExecutionContext('infrastructure_sentinel', () => safeRmSync(files[key]));
      expect(readUndispatchedWorkItemEvidence(selector)).toEqual({
        ok: false,
        reason: 'incomplete_coordination_evidence',
      });
      const callback = vi.fn();
      expect(() => withUndispatchedWorkItemEvidence(selector, callback)).toThrow(
        'incomplete_coordination_evidence'
      );
      expect(callback).not.toHaveBeenCalled();
    }
  );
  it.each(['items_path', 'leases_path', 'events_path'])(
    'rejects malformed historical rows in %s',
    (key) => {
      write(key, safeReadFile(files[key], 'utf8') + '{"partial":');
      expect(readUndispatchedWorkItemEvidence(selector).ok).toBe(false);
    }
  );
  it.each(['items_path', 'leases_path', 'events_path'])(
    'rejects structurally invalid valid JSON in %s',
    (key) => {
      append(key, {});
      expect(readUndispatchedWorkItemEvidence(selector).ok).toBe(false);
    }
  );
  it.each(['workItemId', 'actionRef', 'approvalRequestId'])(
    'rejects terminal and alternate-ID historical item links by %s',
    (key) => {
      append('items_path', {
        ...unrelated,
        item_id: 'alternate',
        status: 'archived',
        metadata: { nested: { link: selector[key as keyof typeof selector] } },
      });
      expect(readUndispatchedWorkItemEvidence(selector)).toEqual({
        ok: false,
        reason: 'historical_dispatch_evidence',
      });
    }
  );
  it.each(['released', 'expired'])(
    'rejects an orphan %s lease even when no item snapshot remains',
    (status) => {
      append('leases_path', {
        lease_id: 'orphan',
        item_id: selector.workItemId,
        holder_peer_id: 'fixture',
        purpose: 'Fixture',
        status,
        expires_at: '2020-01-01T00:00:00.000Z',
        created_at: '2020-01-01T00:00:00.000Z',
        renewed_at: '2020-01-01T00:00:00.000Z',
      });
      expect(readUndispatchedWorkItemEvidence(selector).ok).toBe(false);
    }
  );
  it('rejects an event-only request UUID link and never calls the commit', () => {
    append('events_path', {
      event_id: 'orphan-event',
      ts: new Date().toISOString(),
      event_type: 'item_attempt_started',
      payload: { binding: { request_id: selector.binding.request_id } },
    });
    const callback = vi.fn();
    expect(() => withUndispatchedWorkItemEvidence(selector, callback)).toThrow(
      'historical_dispatch_evidence'
    );
    expect(callback).not.toHaveBeenCalled();
  });
});
