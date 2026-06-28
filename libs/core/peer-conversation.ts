import AjvModule, { type ValidateFunction } from 'ajv';
import * as crypto from 'node:crypto';

import { logger } from './core.js';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import {
  buildPeerMessageEnvelope,
  loadPeerNetworkCatalog,
  resolvePeerDispatchTarget,
  sendPeerMessage,
  type PeerMessageDispatchReceipt,
  type PeerMessageEnvelope,
  type PeerMessageResponder,
  type PeerMessageResponderContext,
} from './peer-messaging.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';

export type PeerConversationStatus = 'open' | 'active' | 'closed' | 'blocked' | 'failed';
export type PeerConversationMessageKind = 'open' | 'message' | 'reply' | 'handoff' | 'close' | 'status';
export type PeerConversationDirection = 'inbound' | 'outbound';

export interface PeerConversationTranscriptEntry {
  message_id: string;
  kind: PeerConversationMessageKind;
  direction: PeerConversationDirection;
  sender_peer_id: string;
  recipient_peer_id: string;
  text: string;
  created_at: string;
  reply_to_message_id?: string;
  related_work_item_ids?: string[];
  metadata?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface PeerConversationSession {
  session_id: string;
  local_peer_id: string;
  remote_peer_id: string;
  topic: string;
  title?: string;
  status: PeerConversationStatus;
  transport: 'peer-messaging';
  related_work_item_ids: string[];
  metadata?: Record<string, unknown>;
  transcript: PeerConversationTranscriptEntry[];
  last_message_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PeerConversationMessagePayload {
  kind: 'peer_conversation_message';
  session_id: string;
  message_kind: PeerConversationMessageKind;
  topic: string;
  text: string;
  sender_peer_id: string;
  recipient_peer_id: string;
  created_at: string;
  reply_to_message_id?: string;
  related_work_item_ids?: string[];
  metadata?: Record<string, unknown>;
}

export interface PeerConversationResponderResult {
  accepted: true;
  session: PeerConversationSession;
  reply?: PeerConversationTranscriptEntry;
}

export interface CreatePeerConversationSessionInput {
  sessionId?: string;
  localPeerId: string;
  remotePeerId: string;
  topic: string;
  title?: string;
  relatedWorkItemIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface AppendPeerConversationMessageInput {
  sessionId: string;
  localPeerId: string;
  remotePeerId: string;
  kind: PeerConversationMessageKind;
  direction: PeerConversationDirection;
  text: string;
  replyToMessageId?: string;
  relatedWorkItemIds?: string[];
  metadata?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  messageId?: string;
}

export interface SendPeerConversationMessageInput {
  senderPeerId: string;
  recipientPeerId: string;
  topic: string;
  text: string;
  messageKind?: PeerConversationMessageKind;
  sessionId?: string;
  title?: string;
  relatedWorkItemIds?: string[];
  metadata?: Record<string, unknown>;
  replyToMessageId?: string;
  ttlMs?: number;
  catalogPath?: string;
  timeoutMs?: number;
}

export interface CreatePeerConversationResponderOptions {
  peerId: string;
  onMessage?: (context: {
    session: PeerConversationSession;
    message: PeerConversationTranscriptEntry;
    envelope: PeerMessageEnvelope<unknown>;
  }) => Promise<Partial<PeerConversationResponderResult> | void> | Partial<PeerConversationResponderResult> | void;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

const SESSION_SCHEMA_PATH = pathResolver.knowledge('product/schemas/peer-conversation-session.schema.json');
const MESSAGE_SCHEMA_PATH = pathResolver.knowledge('product/schemas/peer-conversation-message.schema.json');
const RUNTIME_ROOT = 'active/shared/runtime/peer-conversations';
const OBSERVABILITY_ROOT = 'active/shared/observability/peer-conversations';
const GOVERNED_ROLE = 'infrastructure_sentinel' as const;

let sessionValidateFn: ValidateFunction | null = null;
let messageValidateFn: ValidateFunction | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function loadSchemaValidator(schemaPath: string): ValidateFunction {
  const raw = safeReadFile(schemaPath, { encoding: 'utf8' }) as string;
  return ajv.compile(JSON.parse(raw));
}

function ensureSessionValidator(): ValidateFunction {
  sessionValidateFn ||= loadSchemaValidator(SESSION_SCHEMA_PATH);
  return sessionValidateFn;
}

function ensureMessageValidator(): ValidateFunction {
  messageValidateFn ||= loadSchemaValidator(MESSAGE_SCHEMA_PATH);
  return messageValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim(),
  );
}

function peerRoot(peerId: string): string {
  return `${RUNTIME_ROOT}/${peerId}`;
}

function sessionsRoot(peerId: string): string {
  return `${peerRoot(peerId)}/sessions`;
}

function sessionPath(peerId: string, sessionId: string): string {
  return `${sessionsRoot(peerId)}/${sessionId}.json`;
}

function eventsPath(peerId: string): string {
  return `${OBSERVABILITY_ROOT}/${peerId}/events.jsonl`;
}

function ensurePeerDir(peerId: string): void {
  withExecutionContext(GOVERNED_ROLE, () => {
    const runtimeDir = pathResolver.resolve(peerRoot(peerId));
    const observabilityDir = pathResolver.resolve(`${OBSERVABILITY_ROOT}/${peerId}`);
    if (!safeExistsSync(runtimeDir)) safeMkdir(runtimeDir, { recursive: true });
    if (!safeExistsSync(observabilityDir)) safeMkdir(observabilityDir, { recursive: true });
    if (!safeExistsSync(pathResolver.resolve(sessionsRoot(peerId)))) {
      safeMkdir(pathResolver.resolve(sessionsRoot(peerId)), { recursive: true });
    }
  });
}

function recordEvent(peerId: string, event: Record<string, unknown>): string {
  ensurePeerDir(peerId);
  const logicalPath = eventsPath(peerId);
  return withExecutionContext(GOVERNED_ROLE, () => {
    safeAppendFileSync(pathResolver.resolve(logicalPath), `${JSON.stringify({ ts: nowIso(), peer_id: peerId, ...event })}\n`);
    return pathResolver.resolve(logicalPath);
  });
}

function sessionSortKey(session: PeerConversationSession): string {
  return session.updated_at || session.created_at;
}

function validatePeerConversationSession(session: unknown): { valid: boolean; errors: string[]; value?: PeerConversationSession } {
  const validate = ensureSessionValidator();
  const valid = validate(session);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (session as PeerConversationSession) : undefined,
  };
}

function validatePeerConversationMessage(message: unknown): { valid: boolean; errors: string[]; value?: PeerConversationMessagePayload } {
  const validate = ensureMessageValidator();
  const valid = validate(message);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (message as PeerConversationMessagePayload) : undefined,
  };
}

function defaultSessionTitle(topic: string, remotePeerId: string): string {
  return `${topic} with ${remotePeerId}`;
}

export function createPeerConversationSession(input: CreatePeerConversationSessionInput): PeerConversationSession {
  const now = nowIso();
  const session: PeerConversationSession = {
    session_id: input.sessionId || `PCS-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    local_peer_id: input.localPeerId,
    remote_peer_id: input.remotePeerId,
    topic: input.topic,
    title: input.title || defaultSessionTitle(input.topic, input.remotePeerId),
    status: 'open',
    transport: 'peer-messaging',
    related_work_item_ids: [...new Set((input.relatedWorkItemIds || []).filter(Boolean))],
    metadata: input.metadata,
    transcript: [],
    created_at: now,
    updated_at: now,
  };
  return session;
}

export function savePeerConversationSession(session: PeerConversationSession): string {
  const result = validatePeerConversationSession(session);
  if (!result.valid) {
    throw new Error(`Invalid peer conversation session: ${result.errors.join('; ')}`);
  }
  return withExecutionContext(GOVERNED_ROLE, () => {
    ensurePeerDir(session.local_peer_id);
    const filePath = sessionPath(session.local_peer_id, session.session_id);
    safeWriteFile(filePath, JSON.stringify(session, null, 2));
    return filePath;
  });
}

export function loadPeerConversationSession(peerId: string, sessionId: string): PeerConversationSession | null {
  const filePath = pathResolver.resolve(sessionPath(peerId, sessionId));
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as PeerConversationSession;
  const result = validatePeerConversationSession(parsed);
  if (!result.valid) {
    logger.warn(`[peer-conversation] invalid session ${peerId}/${sessionId}: ${result.errors.join('; ')}`);
    return null;
  }
  return parsed;
}

export function listPeerConversationSessions(peerId: string): PeerConversationSession[] {
  const root = pathResolver.resolve(sessionsRoot(peerId));
  if (!safeExistsSync(root)) return [];
  return safeReaddir(root)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadPeerConversationSession(peerId, entry.replace(/\.json$/, '')))
    .filter((session): session is PeerConversationSession => Boolean(session))
    .sort((a, b) => sessionSortKey(b).localeCompare(sessionSortKey(a)));
}

export function appendPeerConversationTranscript(
  input: AppendPeerConversationMessageInput,
): PeerConversationSession {
  const session = loadPeerConversationSession(input.localPeerId, input.sessionId) ||
    createPeerConversationSession({
      sessionId: input.sessionId,
      localPeerId: input.localPeerId,
      remotePeerId: input.remotePeerId,
      topic: input.payload?.topic ? String(input.payload.topic) : input.kind,
      title: input.payload?.title ? String(input.payload.title) : undefined,
      relatedWorkItemIds: input.relatedWorkItemIds,
      metadata: input.metadata,
    });

  const entry: PeerConversationTranscriptEntry = {
    message_id: input.messageId || randomId('PCM'),
    kind: input.kind,
    direction: input.direction,
    sender_peer_id: input.direction === 'outbound' ? input.localPeerId : input.remotePeerId,
    recipient_peer_id: input.direction === 'outbound' ? input.remotePeerId : input.localPeerId,
    text: input.text,
    created_at: nowIso(),
    ...(input.replyToMessageId ? { reply_to_message_id: input.replyToMessageId } : {}),
    ...(input.relatedWorkItemIds && input.relatedWorkItemIds.length
      ? { related_work_item_ids: [...new Set(input.relatedWorkItemIds.filter(Boolean))] }
      : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
  };

  session.transcript = [...session.transcript, entry].slice(-200);
  session.related_work_item_ids = [
    ...new Set([
      ...session.related_work_item_ids,
      ...(input.relatedWorkItemIds || []),
      ...((input.payload?.related_work_item_ids as string[] | undefined) || []),
    ].filter(Boolean)),
  ];
  session.status = input.kind === 'close' ? 'closed' : input.kind === 'handoff' ? 'active' : 'active';
  session.last_message_at = entry.created_at;
  session.updated_at = entry.created_at;
  savePeerConversationSession(session);
  recordEvent(input.localPeerId, {
    type: 'conversation_message_recorded',
    session_id: session.session_id,
    direction: input.direction,
    kind: input.kind,
    remote_peer_id: input.remotePeerId,
    message_id: entry.message_id,
  });
  return session;
}

export function buildPeerConversationEnvelope(input: {
  senderPeerId: string;
  recipientPeerId: string;
  sharedSecret: string;
  sessionId: string;
  topic: string;
  text: string;
  messageKind?: PeerConversationMessageKind;
  relatedWorkItemIds?: string[];
  metadata?: Record<string, unknown>;
  replyToMessageId?: string;
  ttlMs?: number;
}): PeerMessageEnvelope<PeerConversationMessagePayload> {
  return buildPeerMessageEnvelope<PeerConversationMessagePayload>({
    senderPeerId: input.senderPeerId,
    recipientPeerId: input.recipientPeerId,
    subject: `conversation.${input.messageKind || 'message'}`,
    type: 'request',
    payload: {
      kind: 'peer_conversation_message',
      session_id: input.sessionId,
      message_kind: input.messageKind || 'message',
      topic: input.topic,
      text: input.text,
      sender_peer_id: input.senderPeerId,
      recipient_peer_id: input.recipientPeerId,
      created_at: nowIso(),
      ...(input.replyToMessageId ? { reply_to_message_id: input.replyToMessageId } : {}),
      ...(input.relatedWorkItemIds && input.relatedWorkItemIds.length
        ? { related_work_item_ids: [...new Set(input.relatedWorkItemIds.filter(Boolean))] }
        : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    sharedSecret: input.sharedSecret,
    conversationId: input.sessionId,
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    ...(typeof input.ttlMs === 'number' ? { ttlMs: input.ttlMs } : {}),
  });
}

export async function sendPeerConversationMessageToPeer(
  input: SendPeerConversationMessageInput,
): Promise<{
  session: PeerConversationSession;
  receipt: PeerMessageDispatchReceipt;
}> {
  const catalog = loadPeerNetworkCatalog(input.catalogPath ? { catalogPath: input.catalogPath } : {});
  const target = resolvePeerDispatchTarget(input.recipientPeerId, catalog);
  const sessionId = input.sessionId || randomId('PCS');
  const localSession = appendPeerConversationTranscript({
    sessionId,
    localPeerId: input.senderPeerId,
    remotePeerId: input.recipientPeerId,
    kind: input.messageKind || 'message',
    direction: 'outbound',
    text: input.text,
    relatedWorkItemIds: input.relatedWorkItemIds,
    metadata: input.metadata,
    replyToMessageId: input.replyToMessageId,
    payload: {
      topic: input.topic,
      title: input.title || defaultSessionTitle(input.topic, input.recipientPeerId),
    },
  });

  const envelope = buildPeerConversationEnvelope({
    senderPeerId: input.senderPeerId,
    recipientPeerId: target.peer.peer_id,
    sharedSecret: target.sharedSecret,
    sessionId,
    topic: input.topic,
    text: input.text,
    messageKind: input.messageKind || 'message',
    relatedWorkItemIds: input.relatedWorkItemIds,
    metadata: input.metadata,
    replyToMessageId: input.replyToMessageId,
    ttlMs: input.ttlMs,
  });

  const receipt = await sendPeerMessage(envelope, {
    destinationUrl: target.destinationUrl,
    allowLocalNetwork: target.allowLocalNetwork,
    timeoutMs: input.timeoutMs,
  });

  const response = receipt.response as any;
  if (response?.reply && typeof response.reply === 'object') {
    const reply = response.reply as Partial<PeerConversationTranscriptEntry>;
    appendPeerConversationTranscript({
      sessionId,
      localPeerId: input.senderPeerId,
      remotePeerId: input.recipientPeerId,
      kind: (reply.kind as PeerConversationMessageKind) || 'reply',
      direction: 'inbound',
      text: String(reply.text || ''),
      replyToMessageId: reply.reply_to_message_id || envelope.message_id,
      relatedWorkItemIds: reply.related_work_item_ids || input.relatedWorkItemIds,
      metadata: reply.metadata,
      payload: {
        ...(reply.payload || {}),
        reply_from_peer_id: input.recipientPeerId,
      },
      messageId: reply.message_id,
    });
  }

  return {
    session: loadPeerConversationSession(input.senderPeerId, sessionId) || localSession,
    receipt,
  };
}

export function clearPeerConversationRuntime(peerId: string): void {
  withExecutionContext(GOVERNED_ROLE, () => {
    const runtimeDir = pathResolver.resolve(peerRoot(peerId));
    const observabilityDir = pathResolver.resolve(`${OBSERVABILITY_ROOT}/${peerId}`);
    if (safeExistsSync(runtimeDir)) safeRmSync(runtimeDir, { recursive: true, force: true });
    if (safeExistsSync(observabilityDir)) safeRmSync(observabilityDir, { recursive: true, force: true });
  });
}

export function createPeerConversationResponder(
  options: CreatePeerConversationResponderOptions,
): PeerMessageResponder {
  return async (context: PeerMessageResponderContext): Promise<unknown> => {
    const payload = validatePeerConversationMessage(context.envelope.payload);
    if (!payload.valid || !payload.value) {
      throw new Error(`invalid_peer_conversation_message:${payload.errors.join('; ')}`);
    }

    const message = payload.value;
    const session = appendPeerConversationTranscript({
      sessionId: message.session_id,
      localPeerId: options.peerId,
      remotePeerId: context.envelope.sender_peer_id,
      kind: message.message_kind,
      direction: 'inbound',
      text: message.text,
      replyToMessageId: message.reply_to_message_id,
      relatedWorkItemIds: message.related_work_item_ids,
      metadata: message.metadata,
      payload: {
        topic: message.topic,
        kind: message.kind,
      },
      messageId: context.envelope.message_id,
    });

    const maybeReply = (await options.onMessage?.({
      session,
      message: session.transcript[session.transcript.length - 1],
      envelope: context.envelope,
    })) as Partial<PeerConversationResponderResult> | void;

    const replyResult = maybeReply as Partial<PeerConversationResponderResult> | undefined;
    const replyText = replyResult?.reply?.text || `Received by ${options.peerId}: ${message.text}`;
    const reply: PeerConversationTranscriptEntry = replyResult?.reply || {
      message_id: randomId('PCR'),
      kind: message.message_kind === 'close' ? 'close' : 'reply',
      direction: 'outbound',
      sender_peer_id: options.peerId,
      recipient_peer_id: context.envelope.sender_peer_id,
      text: replyText,
      created_at: nowIso(),
      ...(message.related_work_item_ids?.length
        ? { related_work_item_ids: [...new Set(message.related_work_item_ids)] }
        : {}),
      ...(message.reply_to_message_id ? { reply_to_message_id: message.reply_to_message_id } : {}),
      payload: {
        conversation_session_id: session.session_id,
        peer_id: options.peerId,
      },
    };

    const updatedSession = appendPeerConversationTranscript({
      sessionId: message.session_id,
      localPeerId: options.peerId,
      remotePeerId: context.envelope.sender_peer_id,
      kind: reply.kind,
      direction: 'outbound',
      text: reply.text,
      replyToMessageId: message.reply_to_message_id || context.envelope.message_id,
      relatedWorkItemIds: reply.related_work_item_ids || message.related_work_item_ids,
      metadata: reply.metadata,
      payload: reply.payload,
      messageId: reply.message_id,
    });

    return {
      accepted: true,
      session: updatedSession,
      reply,
    } satisfies PeerConversationResponderResult;
  };
}
