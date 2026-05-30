import {
  buildPeerMessageEnvelope,
  type PeerMessageEnvelope,
  type PeerMessageResponder,
  type PeerMessageResponderContext,
} from './peer-messaging.js';
import {
  appendCoordinationEvent,
  claimWorkItem,
  handoffWorkItem,
  releaseWorkItem,
  updateWorkItem,
  type WorkCoordinationEventType,
  type WorkItemStatus,
} from './work-coordination.js';

export type WorkCoordinationPeerCommandType =
  | 'claim_request'
  | 'release_request'
  | 'handoff_request'
  | 'status_update'
  | 'review_request'
  | 'external_sync_notice';

export interface WorkCoordinationPeerCommandPayload {
  command_type: WorkCoordinationPeerCommandType;
  command_id: string;
  item_id?: string;
  expected_version?: number;
  actor_peer_id?: string;
  actor_user_id?: string;
  idempotency_key?: string;
  purpose?: string;
  ttl_ms?: number;
  from_lease_id?: string;
  from_peer_id?: string;
  to_peer_id?: string;
  to_user_id?: string;
  next_status?: WorkItemStatus;
  board_id?: string;
  note?: string;
  payload?: Record<string, unknown>;
}

export interface WorkCoordinationPeerCommandEnvelope extends PeerMessageEnvelope<{
  coordination: WorkCoordinationPeerCommandPayload;
}> {}

export interface WorkCoordinationPeerCommandResult {
  ok: boolean;
  command_type: WorkCoordinationPeerCommandType;
  command_id: string;
  accepted: boolean;
  result?: Record<string, unknown>;
  error?: string;
  error_code?: string;
}

function isPayloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractCommandPayload(envelope: PeerMessageEnvelope): WorkCoordinationPeerCommandPayload | null {
  const payload = envelope.payload;
  if (!isPayloadRecord(payload)) return null;
  const coordination = payload.coordination;
  if (!isPayloadRecord(coordination)) return null;
  const commandType = String(coordination.command_type || '').trim() as WorkCoordinationPeerCommandType;
  const commandId = String(coordination.command_id || '').trim();
  if (!commandType || !commandId) return null;
  return {
    command_type: commandType,
    command_id: commandId,
    ...(coordination.item_id ? { item_id: String(coordination.item_id) } : {}),
    ...(typeof coordination.expected_version === 'number' ? { expected_version: coordination.expected_version } : {}),
    ...(coordination.actor_peer_id ? { actor_peer_id: String(coordination.actor_peer_id) } : {}),
    ...(coordination.actor_user_id ? { actor_user_id: String(coordination.actor_user_id) } : {}),
    ...(coordination.idempotency_key ? { idempotency_key: String(coordination.idempotency_key) } : {}),
    ...(coordination.purpose ? { purpose: String(coordination.purpose) } : {}),
    ...(typeof coordination.ttl_ms === 'number' ? { ttl_ms: coordination.ttl_ms } : {}),
    ...(coordination.from_lease_id ? { from_lease_id: String(coordination.from_lease_id) } : {}),
    ...(coordination.from_peer_id ? { from_peer_id: String(coordination.from_peer_id) } : {}),
    ...(coordination.to_peer_id ? { to_peer_id: String(coordination.to_peer_id) } : {}),
    ...(coordination.to_user_id ? { to_user_id: String(coordination.to_user_id) } : {}),
    ...(coordination.next_status ? { next_status: String(coordination.next_status) as WorkItemStatus } : {}),
    ...(coordination.board_id ? { board_id: String(coordination.board_id) } : {}),
    ...(coordination.note ? { note: String(coordination.note) } : {}),
    ...(isPayloadRecord(coordination.payload) ? { payload: coordination.payload } : {}),
  };
}

function commandError(command_type: WorkCoordinationPeerCommandType, command_id: string, error: unknown): WorkCoordinationPeerCommandResult {
  if (error instanceof Error) {
    return {
      ok: false,
      command_type,
      command_id,
      accepted: false,
      error: error.message,
      error_code: (error as any).code || error.name || 'command_failed',
    };
  }
  return {
    ok: false,
    command_type,
    command_id,
    accepted: false,
    error: String(error),
    error_code: 'command_failed',
  };
}

export function processWorkCoordinationPeerCommand(
  context: PeerMessageResponderContext,
): WorkCoordinationPeerCommandResult {
  const command = extractCommandPayload(context.envelope);
  if (!command) {
    return {
      ok: false,
      command_type: 'external_sync_notice',
      command_id: 'invalid',
      accepted: false,
      error: 'invalid coordination payload',
      error_code: 'validation_error',
    };
  }

  try {
    switch (command.command_type) {
      case 'claim_request': {
        const itemId = command.item_id || '';
        if (!itemId) throw new Error('missing item_id');
        const actorPeerId = command.actor_peer_id || context.envelope.sender_peer_id;
        const result = claimWorkItem({
          itemId,
          actorPeerId,
          actorUserId: command.actor_user_id,
          purpose: command.purpose || 'implementation',
          ttlMs: command.ttl_ms,
          expectedVersion: command.expected_version,
          idempotencyKey: command.idempotency_key,
        });
        return {
          ok: true,
          command_type: command.command_type,
          command_id: command.command_id,
          accepted: true,
          result,
        };
      }
      case 'release_request': {
        const itemId = command.item_id || '';
        const leaseId = command.from_lease_id || '';
        if (!itemId || !leaseId) throw new Error('missing item_id or from_lease_id');
        const actorPeerId = command.actor_peer_id || context.envelope.sender_peer_id;
        const result = releaseWorkItem({
          itemId,
          leaseId,
          actorPeerId,
          actorUserId: command.actor_user_id,
          expectedVersion: command.expected_version,
          nextStatus: command.next_status,
        });
        return {
          ok: true,
          command_type: command.command_type,
          command_id: command.command_id,
          accepted: true,
          result,
        };
      }
      case 'handoff_request': {
        const itemId = command.item_id || '';
        const fromLeaseId = command.from_lease_id || '';
        const fromPeerId = command.from_peer_id || command.actor_peer_id || context.envelope.sender_peer_id;
        const toPeerId = command.to_peer_id || '';
        if (!itemId || !fromLeaseId || !toPeerId) throw new Error('missing item_id, from_lease_id, or to_peer_id');
        const result = handoffWorkItem({
          itemId,
          fromLeaseId,
          fromPeerId,
          toPeerId,
          toUserId: command.to_user_id,
          purpose: command.purpose || 'implementation',
          ttlMs: command.ttl_ms,
          expectedVersion: command.expected_version,
          idempotencyKey: command.idempotency_key,
        });
        return {
          ok: true,
          command_type: command.command_type,
          command_id: command.command_id,
          accepted: true,
          result,
        };
      }
      case 'status_update': {
        const itemId = command.item_id || '';
        if (!itemId) throw new Error('missing item_id');
        const result = updateWorkItem({
          itemId,
          expectedVersion: command.expected_version,
          status: command.next_status,
          metadata: command.payload,
        });
        return {
          ok: true,
          command_type: command.command_type,
          command_id: command.command_id,
          accepted: true,
          result: { item: result },
        };
      }
      case 'review_request':
      case 'external_sync_notice': {
        const eventType: WorkCoordinationEventType =
          command.command_type === 'review_request' ? 'review_requested' : 'external_sync_pulled';
        const event = appendCoordinationEvent({
          eventType,
          itemId: command.item_id,
          boardId: command.board_id,
          commandId: command.command_id,
          idempotencyKey: command.idempotency_key,
          expectedVersion: command.expected_version,
          actorPeerId: command.actor_peer_id || context.envelope.sender_peer_id,
          actorUserId: command.actor_user_id,
          note: command.note,
          payload: command.payload,
        });
        return {
          ok: true,
          command_type: command.command_type,
          command_id: command.command_id,
          accepted: true,
          result: { event },
        };
      }
      default:
        return {
          ok: false,
          command_type: command.command_type,
          command_id: command.command_id,
          accepted: false,
          error: `unsupported command type: ${command.command_type}`,
          error_code: 'unsupported_command',
        };
    }
  } catch (error) {
    return commandError(command.command_type, command.command_id, error);
  }
}

export function createWorkCoordinationPeerResponder(): PeerMessageResponder {
  return async (context) => processWorkCoordinationPeerCommand(context);
}

export function buildWorkCoordinationPeerCommandEnvelope(input: {
  senderPeerId: string;
  recipientPeerId: string;
  sharedSecret: string;
  subject?: string;
  command: WorkCoordinationPeerCommandPayload;
  conversationId?: string;
  replyToMessageId?: string;
  correlationId?: string;
  ttlMs?: number;
}): WorkCoordinationPeerCommandEnvelope {
  return buildPeerMessageEnvelope({
    senderPeerId: input.senderPeerId,
    recipientPeerId: input.recipientPeerId,
    subject: input.subject || `coordination.${input.command.command_type}`,
    type: 'request',
    payload: { coordination: input.command },
    sharedSecret: input.sharedSecret,
    conversationId: input.conversationId,
    replyToMessageId: input.replyToMessageId,
    correlationId: input.correlationId,
    ttlMs: input.ttlMs,
  });
}
