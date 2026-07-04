import * as crypto from 'node:crypto';

import { appendGovernedArtifactJsonl, type GovernedArtifactRole } from './artifact-store.js';
import { withExecutionContext } from './authority.js';
import {
  buildPeerMessageEnvelope,
  sendPeerMessage,
  type PeerMessageDispatchReceipt,
  type PeerMessageEnvelope,
  type PeerMessageResponder,
  type PeerNetworkPeerRecord,
  verifyPeerMessage,
} from './peer-messaging.js';
import {
  buildWorkCoordinationPeerCommandEnvelope,
  type WorkCoordinationPeerCommandEnvelope,
} from './work-coordination-peer.js';
import { safeExistsSync, safeRmSync } from './secure-io.js';
import type { A2AMessage } from './a2a-bridge.js';
import { signA2AMessage } from './a2a-bridge.js';
import type { MeshRequest, MeshRequestKind, MeshTargetSelector } from './mesh-hub-contract.js';

const DEFAULT_RUNTIME_ROOT = 'active/shared/runtime/mesh-hub';
const DEFAULT_OBSERVABILITY_ROOT = 'active/shared/observability/mesh-hub';
const DEFAULT_WRITER_ROLE: GovernedArtifactRole = 'infrastructure_sentinel';

export interface MeshHubPeerMessagingAdapterOptions {
  peerId: string;
  sharedSecret: string;
  namespace?: string;
}

export interface MeshHubRecipientProposalRecord {
  kind: 'mesh-hub-recipient-proposal';
  proposal_id: string;
  peer_id: string;
  request_id: string;
  message_id: string;
  request_kind: MeshRequestKind;
  selector: MeshTargetSelector;
  proposal_kind: 'a2a' | 'workitem';
  proposal_ref: {
    type: 'a2a-message' | 'workitem-command';
    payload: A2AMessage | WorkCoordinationPeerCommandEnvelope;
  };
  mission_controller_mutation: 'deny';
  created_at: string;
}

export interface MeshHubDispatchInput {
  recipient: PeerNetworkPeerRecord;
  request: MeshRequest;
  timeoutMs?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeNamespace(namespace?: string): string {
  return String(namespace || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function meshHubRuntimeRoot(namespace?: string): string {
  const baseRoot = process.env.KYBERION_MESH_HUB_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT;
  const suffix = normalizeNamespace(namespace);
  return suffix ? `${baseRoot}/${suffix}` : baseRoot;
}

function meshHubObservabilityRoot(namespace?: string): string {
  const baseRoot = process.env.KYBERION_MESH_HUB_OBSERVABILITY_ROOT || DEFAULT_OBSERVABILITY_ROOT;
  const suffix = normalizeNamespace(namespace);
  return suffix ? `${baseRoot}/${suffix}` : baseRoot;
}

function proposalsPath(namespace: string | undefined, peerId: string): string {
  return `${meshHubRuntimeRoot(namespace)}/adapters/${peerId}/proposals.jsonl`;
}

function eventsPath(namespace: string | undefined, peerId: string): string {
  return `${meshHubObservabilityRoot(namespace)}/adapters/${peerId}/events.jsonl`;
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function appendRecord(role: GovernedArtifactRole, logicalPath: string, record: unknown): string {
  return appendGovernedArtifactJsonl(role, logicalPath, record);
}

function recordEvent(
  namespace: string | undefined,
  peerId: string,
  event: Record<string, unknown>
): string {
  return appendRecord(DEFAULT_WRITER_ROLE, eventsPath(namespace, peerId), {
    ts: nowIso(),
    peer_id: peerId,
    ...event,
  });
}

function buildWorkitemCommand(
  request: MeshRequest,
  peerId: string,
  sharedSecret: string
): WorkCoordinationPeerCommandEnvelope {
  const commandType =
    request.request_kind === 'workitem.handoff'
      ? 'handoff_request'
      : request.request_kind === 'workitem.status_update'
        ? 'status_update'
        : 'claim_request';
  return buildWorkCoordinationPeerCommandEnvelope({
    senderPeerId: peerId,
    recipientPeerId: peerId,
    sharedSecret,
    command: {
      command_type: commandType,
      command_id: request.request_id,
      item_id: request.request_id,
      actor_peer_id: request.sender_peer_id,
      purpose:
        request.target.selector.kind === 'topic'
          ? request.target.selector.topic
          : request.request_kind,
      payload: {
        reference: request.payload.reference,
      },
    },
    correlationId: request.correlation_id,
  });
}

function buildA2AProposal(peerId: string, request: MeshRequest): A2AMessage {
  const message: A2AMessage = {
    a2a_version: '1.0',
    header: {
      msg_id: randomId('A2A'),
      sender: peerId,
      receiver: peerId,
      conversation_id: request.correlation_id,
      correlation_id: request.correlation_id,
      performative: 'propose',
      timestamp: nowIso(),
    },
    payload: {
      request_id: request.request_id,
      request_kind: request.request_kind,
      selector: request.target.selector,
      payload: request.payload,
      mission_controller_mutation: 'deny',
    },
  };
  message.header.signature = signA2AMessage(message);
  return message;
}

function buildProposalRecord(
  peerId: string,
  messageId: string,
  request: MeshRequest,
  sharedSecret: string
): MeshHubRecipientProposalRecord {
  const proposalKind = request.request_kind.startsWith('workitem.') ? 'workitem' : 'a2a';
  const proposalRef =
    proposalKind === 'workitem'
      ? {
          type: 'workitem-command' as const,
          payload: buildWorkitemCommand(request, peerId, sharedSecret),
        }
      : {
          type: 'a2a-message' as const,
          payload: buildA2AProposal(peerId, request),
        };
  return {
    kind: 'mesh-hub-recipient-proposal',
    proposal_id: randomId('mhp'),
    peer_id: peerId,
    request_id: request.request_id,
    message_id: messageId,
    request_kind: request.request_kind,
    selector: request.target.selector,
    proposal_kind: proposalKind,
    proposal_ref: proposalRef,
    mission_controller_mutation: 'deny',
    created_at: nowIso(),
  };
}

function validateRequestEnvelope(
  envelope: PeerMessageEnvelope,
  peerId: string,
  sharedSecret: string
): MeshRequest {
  if (envelope.type !== 'request') {
    throw new Error(`mesh_hub_request_type_denied:${envelope.message_id}`);
  }
  if (envelope.recipient_peer_id !== peerId) {
    throw new Error(`mesh_hub_recipient_mismatch:${envelope.message_id}`);
  }
  if (!envelope.signature || !verifyPeerMessage(envelope, sharedSecret)) {
    throw new Error(`mesh_hub_signature_invalid:${envelope.message_id}`);
  }
  const request = envelope.payload as MeshRequest;
  if (!request || request.kind !== 'mesh-request') {
    throw new Error(`mesh_hub_invalid_payload:${envelope.message_id}`);
  }
  if (
    request.target.selector.kind === 'topic' &&
    request.request_kind === 'workitem.status_update'
  ) {
    throw new Error(`mesh_hub_topic_status_update_denied:${request.request_id}`);
  }
  return request;
}

export class MeshHubPeerMessagingAdapter {
  constructor(private readonly options: MeshHubPeerMessagingAdapterOptions) {}

  public createResponder(): PeerMessageResponder {
    return async ({ peerId, envelope }) => {
      const request = validateRequestEnvelope(envelope, peerId, this.options.sharedSecret);
      const proposal = buildProposalRecord(
        peerId,
        envelope.message_id,
        request,
        this.options.sharedSecret
      );
      appendRecord(DEFAULT_WRITER_ROLE, proposalsPath(this.options.namespace, peerId), proposal);
      recordEvent(this.options.namespace, peerId, {
        type: 'mesh_hub_request_proposed',
        request_id: request.request_id,
        message_id: envelope.message_id,
        request_kind: request.request_kind,
        proposal_kind: proposal.proposal_kind,
        mission_controller_mutation: 'deny',
      });
      return {
        accepted: true,
        proposal,
      };
    };
  }

  public async dispatchToPeer(input: MeshHubDispatchInput): Promise<PeerMessageDispatchReceipt> {
    const envelope = buildPeerMessageEnvelope({
      senderPeerId: this.options.peerId,
      recipientPeerId: input.recipient.peer_id,
      subject: `mesh.${input.request.request_kind}`,
      type: 'request',
      payload: input.request,
      sharedSecret: input.recipient.shared_secret || this.options.sharedSecret,
      conversationId: input.request.correlation_id,
      correlationId: input.request.correlation_id,
      ttlMs: input.request.ttl_ms,
    });
    recordEvent(this.options.namespace, input.recipient.peer_id, {
      type: 'mesh_hub_request_dispatched',
      request_id: input.request.request_id,
      message_id: envelope.message_id,
      request_kind: input.request.request_kind,
      destination_url: input.recipient.base_url,
    });
    return sendPeerMessage(envelope, {
      destinationUrl: input.recipient.base_url,
      allowLocalNetwork: input.recipient.allow_local_network !== false,
      timeoutMs: input.timeoutMs,
    });
  }
}

export function createMeshHubPeerMessagingAdapter(
  options: MeshHubPeerMessagingAdapterOptions
): MeshHubPeerMessagingAdapter {
  return new MeshHubPeerMessagingAdapter(options);
}

export function clearMeshHubPeerMessagingAdapterNamespace(namespace?: string): void {
  const normalized = normalizeNamespace(namespace);
  const root = normalized ? `${meshHubRuntimeRoot(normalized)}` : meshHubRuntimeRoot();
  const obsRoot = normalized
    ? `${meshHubObservabilityRoot(normalized)}`
    : meshHubObservabilityRoot();
  withExecutionContext(DEFAULT_WRITER_ROLE, () => {
    if (safeExistsSync(root)) safeRmSync(root, { recursive: true, force: true });
    if (safeExistsSync(obsRoot)) safeRmSync(obsRoot, { recursive: true, force: true });
  });
}
