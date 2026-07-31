import {
  claimWorkItem,
  releaseWorkItem,
  updateWorkItem,
  listActiveWorkLeases,
  listWorkItems,
  type WorkItemStatus,
} from '@agent/core';
import { auditAction, toActionResult, HUD_PEER_ID, type ActionResult } from './dispatch.js';

const STATUS_CYCLE: WorkItemStatus[] = ['backlog', 'ready', 'in_progress', 'review', 'done'];

export function claimItem(itemId: string): ActionResult {
  try {
    const { lease } = claimWorkItem({
      itemId,
      actorPeerId: HUD_PEER_ID,
      purpose: 'terminal-hud operator claim',
    });
    return auditAction(
      'work.claim',
      { ok: true, message: `claimed (${lease.lease_id})` },
      { itemId }
    );
  } catch (err) {
    return auditAction('work.claim', toActionResult(err), { itemId });
  }
}

export function releaseItem(itemId: string): ActionResult {
  try {
    const lease = listActiveWorkLeases().find((candidate) => candidate.item_id === itemId);
    if (!lease) {
      return auditAction('work.release', { ok: false, message: 'no active lease' }, { itemId });
    }
    if (lease.holder_peer_id !== HUD_PEER_ID) {
      // Multi-provider co-execution contract: only the claim holder writes.
      return auditAction(
        'work.release',
        { ok: false, message: `lease held by ${lease.holder_peer_id}` },
        { itemId }
      );
    }
    releaseWorkItem({ itemId, leaseId: lease.lease_id, actorPeerId: HUD_PEER_ID });
    return auditAction('work.release', { ok: true, message: 'released' }, { itemId });
  } catch (err) {
    return auditAction('work.release', toActionResult(err), { itemId });
  }
}

export function advanceItemStatus(itemId: string): ActionResult {
  try {
    const item = listWorkItems({}).find((candidate) => candidate.item_id === itemId);
    if (!item) return { ok: false, message: `not found: ${itemId}` };
    const currentIdx = STATUS_CYCLE.indexOf(item.status);
    const next = STATUS_CYCLE[(currentIdx + 1) % STATUS_CYCLE.length];
    updateWorkItem({ itemId, expectedVersion: item.version, status: next });
    return auditAction(
      'work.status',
      { ok: true, message: `${item.status} → ${next}` },
      { itemId }
    );
  } catch (err) {
    return auditAction('work.status', toActionResult(err), { itemId });
  }
}
