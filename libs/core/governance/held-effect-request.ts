import { createApprovalRequest } from './approval-store.js';
import type { HeldActionApprovalLink, HeldActionSteeringSpec } from './held-effect-bridge.js';
import type { GovernedArtifactRole } from '../workforce/artifact-store.js';

/**
 * SC-04: file the linked approval-store request steering `held_effect`. The
 * request — not the held record — becomes the decision of record; the held
 * record keeps the link so every decision path converges.
 */
export function createHeldApprovalRequest(
  record: {
    id: string;
    op: string;
    missionId: string;
    taskId?: string;
    tenantSlug?: string;
    effectBinding: string;
    payloadHash: string;
  },
  spec: HeldActionSteeringSpec
): HeldActionApprovalLink {
  const role: GovernedArtifactRole = 'mission_controller';
  const request = createApprovalRequest(role, {
    channel: spec.channel,
    storageChannel: spec.storageChannel || spec.channel,
    threadTs: spec.threadTs,
    correlationId: spec.correlationId,
    requestedBy: spec.requestedBy,
    draft: {
      title: spec.title,
      summary: spec.summary,
      details: `held_effect ${record.op} (${record.id})`,
      severity: 'medium',
    },
    scope: {
      mission_id: record.missionId,
      ...(record.taskId ? { task_id: record.taskId } : {}),
      ...(record.tenantSlug ? { tenant_slug: record.tenantSlug } : {}),
    },
    steering: {
      kind: 'held_effect',
      heldActionId: record.id,
      op: record.op,
      effectBinding: record.effectBinding,
      payloadHash: record.payloadHash,
      missionId: record.missionId,
      tenantSlug: record.tenantSlug,
      surface: spec.surface,
      channel: spec.channel,
      threadTs: spec.threadTs,
      correlationId: spec.correlationId,
    },
  });
  return { requestId: request.id, storageChannel: request.storageChannel, role };
}
