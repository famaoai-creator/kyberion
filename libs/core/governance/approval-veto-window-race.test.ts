/**
 * The veto-window tick lists pending requests first and settles each under its
 * record lock. A transition recorded between the listing and the lock (here: a
 * fallback to a human decision) must win: the tick re-evaluates the fresh
 * record and never auto-approves a window that is no longer elapsed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  listed: null as null | unknown[],
}));
vi.mock('./approval-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./approval-store.js')>();
  return {
    ...real,
    // Serve the tick a snapshot taken before the concurrent transition.
    listApprovalRequests: (...args: Parameters<typeof real.listApprovalRequests>) =>
      hooks.listed ?? real.listApprovalRequests(...args),
  };
});

import {
  approvalRequestLogicalPath,
  approvalStoreRoots,
  createApprovalRequest,
  listApprovalRequests,
  loadApprovalRequest,
} from './approval-store.js';
import {
  buildVetoWindow,
  markApprovalNotificationDelivered,
  tickVetoWindows,
} from './approval-veto-window.js';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { writeGovernedArtifactJson } from '../workforce/artifact-store.js';

const CHANNEL = `veto-race-${process.pid}`;
const NOON = Date.parse('2026-09-28T03:00:00Z');
const MINUTE = 60_000;

afterEach(() => {
  hooks.listed = null;
  withExecutionContext('mission_controller', () => {
    for (const root of Object.values(approvalStoreRoots())) {
      const dir = pathResolver.rootResolve(`${root}/${CHANNEL}`);
      if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('veto-window tick under the record lock', () => {
  it('does not auto-approve when a fallback was recorded after the listing', () => {
    const record = createApprovalRequest('mission_controller', {
      channel: CHANNEL,
      threadTs: '',
      correlationId: 'veto-race',
      requestedBy: 'agent:test',
      draft: { title: 'veto race', summary: 'fallback between listing and lock' },
      veto: buildVetoWindow({ windowMinutes: 60, now: NOON }),
    });
    markApprovalNotificationDelivered('mission_controller', {
      storageChannel: CHANNEL,
      requestId: record.id,
      deliveredAt: new Date(NOON + MINUTE).toISOString(),
    });
    const elapsedAt = NOON + 120 * MINUTE;
    // The tick's listing still sees an elapsed, pending window...
    hooks.listed = listApprovalRequests({ storageChannels: [CHANNEL], status: 'pending' });
    expect(hooks.listed).toHaveLength(1);
    // ...but before it takes the lock the window fell back to a human decision.
    const fresh = loadApprovalRequest(CHANNEL, record.id)!;
    writeGovernedArtifactJson(
      'mission_controller',
      approvalRequestLogicalPath(CHANNEL, record.id),
      { ...fresh, veto: { ...fresh.veto!, fallback: 'undelivered' } }
    );

    const result = tickVetoWindows('mission_controller', {
      now: elapsedAt,
      storageChannels: [CHANNEL],
    });
    expect(result.proceeded).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('pending');

    // Without the concurrent fallback the same tick does proceed.
    const other = createApprovalRequest('mission_controller', {
      channel: CHANNEL,
      threadTs: '',
      correlationId: 'veto-race-control',
      requestedBy: 'agent:test',
      draft: { title: 'veto control', summary: 'elapsed, nothing in between' },
      veto: buildVetoWindow({ windowMinutes: 60, now: NOON }),
    });
    markApprovalNotificationDelivered('mission_controller', {
      storageChannel: CHANNEL,
      requestId: other.id,
      deliveredAt: new Date(NOON + MINUTE).toISOString(),
    });
    hooks.listed = null;
    expect(
      tickVetoWindows('mission_controller', {
        now: elapsedAt,
        storageChannels: [CHANNEL],
      }).proceeded.map((entry) => entry.id)
    ).toEqual([other.id]);
  });
});
