import { logger } from './core.js';
import {
  buildPeerMessageEnvelope,
  resolvePeerRecord,
  PeerMessageResponderContext,
  PeerMessageEnvelope,
  PeerMessageResponder,
} from './peer-messaging.js';
import { claimWorkItem, handoffWorkItem, updateWorkItem } from './work-coordination.js';
import type { WorkItemStatus } from './work-coordination-types.js';
import { isRecord } from './foundation/text.js';

export type WorkCoordinationPeerCommandType = 'claim_request' | 'handoff_request' | 'status_update';

export interface WorkCoordinationPeerCommandPayload {
  command_type: WorkCoordinationPeerCommandType;
  command_id: string;
  item_id: string;
  actor_peer_id?: string;
  actor_user_id?: string;
  purpose?: string;
  expected_version?: number;
  idempotency_key?: string;
  next_status?: WorkItemStatus;
  lease_id?: string;
  assignee_peer_id?: string;
  assignee_user_id?: string;
  payload?: Record<string, unknown> & { ttlMs?: number };
}

export type WorkCoordinationPeerCommandEnvelope =
  PeerMessageEnvelope<WorkCoordinationPeerCommandPayload>;

export interface WorkCoordinationPeerCommandResult {
  ok: boolean;
  accepted: boolean;
  response?: {
    result: unknown;
  };
  error?: string;
}

const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'review',
  'done',
  'archived',
];

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalSafeInteger(value: unknown): number | undefined {
  return value === undefined
    ? undefined
    : Number.isSafeInteger(value) && (value as number) >= 0
      ? (value as number)
      : undefined;
}

function parseWorkCoordinationPeerCommandPayload(
  value: unknown
): WorkCoordinationPeerCommandPayload {
  if (!isRecord(value)) throw new Error('invalid_coordination_command_payload');
  const commandType = value.command_type;
  if (
    commandType !== 'claim_request' &&
    commandType !== 'handoff_request' &&
    commandType !== 'status_update'
  ) {
    throw new Error('invalid_coordination_command_type');
  }
  if (!nonEmptyString(value.command_id) || !nonEmptyString(value.item_id)) {
    throw new Error('invalid_coordination_command_identity');
  }
  const expectedVersion = optionalSafeInteger(value.expected_version);
  if (value.expected_version !== undefined && expectedVersion === undefined) {
    throw new Error('invalid_coordination_expected_version');
  }
  const rawPayload = value.payload;
  let payload: WorkCoordinationPeerCommandPayload['payload'];
  if (rawPayload === undefined) {
    payload = undefined;
  } else {
    if (!isRecord(rawPayload)) throw new Error('invalid_coordination_command_data');
    payload = rawPayload;
  }
  const nextStatus = value.next_status;
  const validNextStatus =
    typeof nextStatus === 'string' && WORK_ITEM_STATUSES.includes(nextStatus as WorkItemStatus)
      ? (nextStatus as WorkItemStatus)
      : undefined;
  if (commandType === 'status_update' && validNextStatus === undefined) {
    throw new Error('invalid_coordination_next_status');
  }
  if (
    commandType === 'handoff_request' &&
    (!nonEmptyString(value.lease_id) || !nonEmptyString(value.assignee_peer_id))
  ) {
    throw new Error('invalid_coordination_handoff_target');
  }
  const ttlMs = payload?.ttlMs;
  if (
    ttlMs !== undefined &&
    (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs < 0)
  ) {
    throw new Error('invalid_coordination_ttl');
  }
  const normalizedPayload =
    payload === undefined
      ? undefined
      : { ...payload, ttlMs: typeof ttlMs === 'number' ? ttlMs : undefined };
  return {
    command_type: commandType,
    command_id: value.command_id,
    item_id: value.item_id,
    ...(nonEmptyString(value.actor_peer_id) ? { actor_peer_id: value.actor_peer_id } : {}),
    ...(nonEmptyString(value.actor_user_id) ? { actor_user_id: value.actor_user_id } : {}),
    ...(nonEmptyString(value.purpose) ? { purpose: value.purpose } : {}),
    ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}),
    ...(nonEmptyString(value.idempotency_key) ? { idempotency_key: value.idempotency_key } : {}),
    ...(validNextStatus !== undefined ? { next_status: validNextStatus } : {}),
    ...(nonEmptyString(value.lease_id) ? { lease_id: value.lease_id } : {}),
    ...(nonEmptyString(value.assignee_peer_id) ? { assignee_peer_id: value.assignee_peer_id } : {}),
    ...(nonEmptyString(value.assignee_user_id) ? { assignee_user_id: value.assignee_user_id } : {}),
    ...(normalizedPayload !== undefined ? { payload: normalizedPayload } : {}),
  };
}

export function buildWorkCoordinationPeerCommandEnvelope(input: {
  tenantId: string;
  senderPeerId: string;
  recipientPeerId: string;
  sharedSecret: string;
  command: WorkCoordinationPeerCommandPayload;
  correlationId?: string;
}): WorkCoordinationPeerCommandEnvelope {
  return buildPeerMessageEnvelope({
    tenantId: input.tenantId,
    senderPeerId: input.senderPeerId,
    recipientPeerId: input.recipientPeerId,
    subject: `coordination.${input.command.command_type}`,
    type: 'request',
    payload: input.command,
    sharedSecret: input.sharedSecret,
    correlationId: input.correlationId,
  });
}

export async function processWorkCoordinationPeerCommand(
  context: PeerMessageResponderContext
): Promise<unknown> {
  const { envelope } = context;
  const senderId = envelope.sender_peer_id;

  // 1. Verify sender is a trusted peer (whitelist check)
  const peerRecord = resolvePeerRecord(senderId);
  if (!peerRecord && senderId !== context.peerId) {
    logger.warn(`[coordination-peer] Rejected untrusted peer message from: ${senderId}`);
    throw new Error(`untrusted_peer:${senderId}`);
  }

  const payload = parseWorkCoordinationPeerCommandPayload(envelope.payload);
  const commandType = payload.command_type;

  logger.info(`[coordination-peer] Handling coordination command: ${commandType} from ${senderId}`);

  switch (commandType) {
    case 'claim_request': {
      const res = claimWorkItem({
        itemId: payload.item_id,
        actorPeerId: payload.actor_peer_id || senderId,
        actorUserId: payload.actor_user_id,
        purpose: payload.purpose || 'coordination',
        ttlMs: payload.payload?.ttlMs,
        expectedVersion: payload.expected_version,
        idempotencyKey: payload.idempotency_key,
      });
      return {
        result: {
          item: res.item,
          lease: res.lease,
        },
      };
    }

    case 'handoff_request': {
      const res = handoffWorkItem({
        itemId: payload.item_id,
        fromLeaseId: payload.lease_id || '',
        fromPeerId: payload.actor_peer_id || senderId,
        toPeerId: payload.assignee_peer_id || '',
        toUserId: payload.assignee_user_id,
        purpose: payload.purpose || 'handoff',
        expectedVersion: payload.expected_version,
        idempotencyKey: payload.idempotency_key,
      });
      return {
        result: {
          item: res.item,
          fromLease: res.fromLease,
          toLease: res.toLease,
        },
      };
    }

    case 'status_update': {
      const res = updateWorkItem({
        itemId: payload.item_id,
        status: payload.next_status as WorkItemStatus,
        expectedVersion: payload.expected_version,
      });
      return {
        result: {
          item: res,
        },
      };
    }

    default:
      throw new Error(`unknown_coordination_command:${commandType}`);
  }
}

export function createWorkCoordinationPeerResponder(): PeerMessageResponder {
  return async (context: PeerMessageResponderContext) => {
    return processWorkCoordinationPeerCommand(context);
  };
}
