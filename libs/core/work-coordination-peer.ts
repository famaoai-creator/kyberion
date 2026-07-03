import { logger } from './core.js';
import {
  buildPeerMessageEnvelope,
  resolvePeerRecord,
  PeerMessageResponderContext,
  PeerMessageEnvelope,
  PeerMessageResponder,
} from './peer-messaging.js';
import {
  claimWorkItem,
  handoffWorkItem,
  updateWorkItem,
  WorkItem,
  WorkLease,
  WorkItemStatus,
} from './work-coordination.js';

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
  next_status?: string;
  lease_id?: string;
  assignee_peer_id?: string;
  assignee_user_id?: string;
  payload?: any;
}

export type WorkCoordinationPeerCommandEnvelope =
  PeerMessageEnvelope<WorkCoordinationPeerCommandPayload>;

export interface WorkCoordinationPeerCommandResult {
  ok: boolean;
  accepted: boolean;
  response?: {
    result: any;
  };
  error?: string;
}

export function buildWorkCoordinationPeerCommandEnvelope(input: {
  senderPeerId: string;
  recipientPeerId: string;
  sharedSecret: string;
  command: WorkCoordinationPeerCommandPayload;
  correlationId?: string;
}): WorkCoordinationPeerCommandEnvelope {
  return buildPeerMessageEnvelope({
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

  const payload = envelope.payload as WorkCoordinationPeerCommandPayload;
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
