import { createApprovalRequest } from './approval-store.js';
import type { GovernedArtifactRole } from '../workforce/artifact-store.js';
import type { HeldActionApprovalLink, HeldActionSteeringSpec } from './held-effect-bridge.js';

/**
 * Minimal held-record shape the request builder needs — keeps this module
 * free of a static control-plane import.
 */
export interface HeldApprovalRequestRecord {
  id: string;
  missionId: string;
  taskId?: string;
  tenantSlug?: string;
  op: string;
  effectBinding: string;
  payloadHash: string;
}

/**
 * SC-04: file the linked approval-store request steering `held_effect`.
 * The request — not the held record — becomes the decision of record.
 */
export function fileHeldApprovalRequest(
  record: HeldApprovalRequestRecord,
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
  return {
    requestId: request.id,
    storageChannel: request.storageChannel,
    role,
  };
}
