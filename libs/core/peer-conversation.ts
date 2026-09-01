import { appendJsonLine } from './foundation/json.js';
import { nowIso } from './foundation/time.js';
import type { ValidateFunction } from 'ajv';
import { compileSchema } from './foundation/ajv.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { isValidTenantSlug } from './entity-scope.js';

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
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';

export type PeerConversationStatus = 'open' | 'active' | 'closed' | 'blocked' | 'failed';
export type PeerConversationMessageKind =
  'open' | 'message' | 'reply' | 'handoff' | 'close' | 'status';
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
  tenant_id: string;
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
  tenant_id: string;
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
  tenantId: string;
  sessionId?: string;
  localPeerId: string;
  remotePeerId: string;
  topic: string;
  title?: string;
  relatedWorkItemIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface AppendPeerConversationMessageInput {
  tenantId: string;
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
  tenantId: string;
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
  tenantId: string;
  onMessage?: (context: {
    session: PeerConversationSession;
    message: PeerConversationTranscriptEntry;
    envelope: PeerMessageEnvelope<unknown>;
  }) =>
    | Promise<Partial<PeerConversationResponderResult> | void>
    | Partial<PeerConversationResponderResult>
    | void;
}

const SESSION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/peer-conversation-session.schema.json'
);
const MESSAGE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/peer-conversation-message.schema.json'
);
const RUNTIME_ROOT = 'active/shared/runtime/peer-conversations';
const OBSERVABILITY_ROOT = 'active/shared/observability/peer-conversations';
const GOVERNED_ROLE = 'infrastructure_sentinel' as const;
const PEER_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

let sessionValidateFn: ValidateFunction | null = null;
let messageValidateFn: ValidateFunction | null = null;

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function loadSchemaValidator(schemaPath: string): ValidateFunction {
  return compileSchema(schemaPath);
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
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function normalizeTenantId(tenantId: string): string {
  const normalized = String(tenantId || '').trim();
  if (!isValidTenantSlug(normalized)) {
    throw new Error(`invalid_peer_conversation_tenant_id:${normalized || 'missing'}`);
  }
  return normalized;
}

function normalizePeerId(peerId: string): string {
  const normalized = String(peerId || '').trim();
  if (!PEER_ID_PATTERN.test(normalized)) {
    throw new Error(`invalid_peer_conversation_peer_id:${normalized || 'missing'}`);
  }
  return normalized;
}

function normalizeSessionId(sessionId: string): string {
  const normalized = String(sessionId || '').trim();
  if (!SESSION_ID_PATTERN.test(normalized)) {
    throw new Error(`invalid_peer_conversation_session_id:${normalized || 'missing'}`);
  }
  return normalized;
}

function safeConversationPath(logicalPath: string): string {
  return assertSafeRepositoryPath(pathResolver.resolve(logicalPath), {
    allowMissingLeaf: true,
  });
}

function peerRoot(tenantId: string, peerId: string): string {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const normalizedPeerId = normalizePeerId(peerId);
  return path.dirname(
    safeConversationPath(
      `${RUNTIME_ROOT}/tenants/${normalizedTenantId}/peers/${normalizedPeerId}/.path-check`
    )
  );
}

function sessionsRoot(tenantId: string, peerId: string): string {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const normalizedPeerId = normalizePeerId(peerId);
  return path.dirname(
    safeConversationPath(
      `${RUNTIME_ROOT}/tenants/${normalizedTenantId}/peers/${normalizedPeerId}/sessions/.path-check`
    )
  );
}

function sessionPath(tenantId: string, peerId: string, sessionId: string): string {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const normalizedPeerId = normalizePeerId(peerId);
  const normalizedSessionId = normalizeSessionId(sessionId);
  return safeConversationPath(
    `${RUNTIME_ROOT}/tenants/${normalizedTenantId}/peers/${normalizedPeerId}/sessions/${normalizedSessionId}.json`
  );
}

function peerConversationSessionCatalog(filePath: string) {
  return defineCatalog<PeerConversationSession>({
    id: 'peer-conversation-session',
    path: filePath,
    schema: SESSION_SCHEMA_PATH,
  });
}

function eventsPath(tenantId: string, peerId: string): string {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const normalizedPeerId = normalizePeerId(peerId);
  return safeConversationPath(
    `${OBSERVABILITY_ROOT}/tenants/${normalizedTenantId}/peers/${normalizedPeerId}/events.jsonl`
  );
}

function ensurePeerDir(tenantId: string, peerId: string): void {
  withExecutionContext(GOVERNED_ROLE, () => {
    const runtimeDir = peerRoot(tenantId, peerId);
    const observabilityDir = path.dirname(eventsPath(tenantId, peerId));
    if (!safeExistsSync(runtimeDir)) safeMkdir(runtimeDir, { recursive: true });
    if (!safeExistsSync(observabilityDir)) safeMkdir(observabilityDir, { recursive: true });
    const sessionsDir = sessionsRoot(tenantId, peerId);
    if (!safeExistsSync(sessionsDir)) {
      safeMkdir(sessionsDir, { recursive: true });
    }
  });
}

function recordEvent(tenantId: string, peerId: string, event: Record<string, unknown>): string {
  ensurePeerDir(tenantId, peerId);
  const logicalPath = eventsPath(tenantId, peerId);
  return withExecutionContext(GOVERNED_ROLE, () => {
    appendJsonLine(pathResolver.resolve(logicalPath), {
      ts: nowIso(),
      tenant_id: tenantId,
      peer_id: peerId,
      ...event,
    });
    return pathResolver.resolve(logicalPath);
  });
}

function sessionSortKey(session: PeerConversationSession): string {
  return session.updated_at || session.created_at;
}

function validatePeerConversationSession(session: unknown): {
  valid: boolean;
  errors: string[];
  value?: PeerConversationSession;
} {
  const validate = ensureSessionValidator();
  const valid = validate(session);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (session as PeerConversationSession) : undefined,
  };
}

function validatePeerConversationMessage(message: unknown): {
  valid: boolean;
  errors: string[];
  value?: PeerConversationMessagePayload;
} {
  const validate = ensureMessageValidator();
  const valid = validate(message);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (message as PeerConversationMessagePayload) : undefined,
  };
}

const PEER_CONVERSATION_MESSAGE_KINDS: readonly PeerConversationMessageKind[] = [
  'open',
  'message',
  'reply',
  'handoff',
  'close',
  'status',
];
const PEER_CONVERSATION_DIRECTIONS: readonly PeerConversationDirection[] = ['inbound', 'outbound'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate a transcript entry before projecting an untrusted peer response. */
export function parsePeerConversationTranscriptEntry(
  value: unknown
): PeerConversationTranscriptEntry {
  if (!isRecord(value)) throw new Error('invalid_peer_conversation_transcript_entry');
  for (const field of ['message_id', 'sender_peer_id', 'recipient_peer_id', 'created_at']) {
    if (!isNonEmptyString(value[field])) {
      throw new Error(`invalid_peer_conversation_transcript_${field}`);
    }
  }
  if (
    !PEER_CONVERSATION_MESSAGE_KINDS.includes(value.kind as PeerConversationMessageKind) ||
    !PEER_CONVERSATION_DIRECTIONS.includes(value.direction as PeerConversationDirection) ||
    typeof value.text !== 'string'
  ) {
    throw new Error('invalid_peer_conversation_transcript_fields');
  }
  for (const field of ['reply_to_message_id'] as const) {
    if (value[field] !== undefined && !isNonEmptyString(value[field])) {
      throw new Error(`invalid_peer_conversation_transcript_${field}`);
    }
  }
  for (const field of ['related_work_item_ids'] as const) {
    if (
      value[field] !== undefined &&
      (!Array.isArray(value[field]) || value[field].some((entry) => !isNonEmptyString(entry)))
    ) {
      throw new Error(`invalid_peer_conversation_transcript_${field}`);
    }
  }
  for (const field of ['metadata', 'payload'] as const) {
    if (value[field] !== undefined && !isRecord(value[field])) {
      throw new Error(`invalid_peer_conversation_transcript_${field}`);
    }
  }
  return value as unknown as PeerConversationTranscriptEntry;
}

function defaultSessionTitle(topic: string, remotePeerId: string): string {
  return `${topic} with ${remotePeerId}`;
}

export function createPeerConversationSession(
  input: CreatePeerConversationSessionInput
): PeerConversationSession {
  const tenantId = normalizeTenantId(input.tenantId);
  const localPeerId = normalizePeerId(input.localPeerId);
  const remotePeerId = normalizePeerId(input.remotePeerId);
  const sessionId = input.sessionId ? normalizeSessionId(input.sessionId) : undefined;
  const now = nowIso();
  const session: PeerConversationSession = {
    tenant_id: tenantId,
    session_id:
      sessionId ||
      `PCS-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    local_peer_id: localPeerId,
    remote_peer_id: remotePeerId,
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
    ensurePeerDir(session.tenant_id, session.local_peer_id);
    const filePath = sessionPath(session.tenant_id, session.local_peer_id, session.session_id);
    safeWriteFile(filePath, JSON.stringify(session, null, 2));
    return filePath;
  });
}

export function loadPeerConversationSession(
  tenantId: string,
  peerId: string,
  sessionId: string
): PeerConversationSession | null {
  const filePath = pathResolver.resolve(sessionPath(tenantId, peerId, sessionId));
  if (!safeExistsSync(filePath)) return null;
  let parsed: PeerConversationSession;
  try {
    parsed = peerConversationSessionCatalog(filePath).load();
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    logger.warn(
      `[peer-conversation] invalid session ${peerId}/${sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
  const result = validatePeerConversationSession(parsed);
  if (!result.valid) {
    logger.warn(
      `[peer-conversation] invalid session ${peerId}/${sessionId}: ${result.errors.join('; ')}`
    );
    return null;
  }
  return parsed;
}

export function listPeerConversationSessions(
  tenantId: string,
  peerId: string
): PeerConversationSession[] {
  const root = pathResolver.resolve(sessionsRoot(tenantId, peerId));
  if (!safeExistsSync(root)) return [];
  return safeReaddir(root)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadPeerConversationSession(tenantId, peerId, entry.replace(/\.json$/, '')))
    .filter((session): session is PeerConversationSession => Boolean(session))
    .sort((a, b) => sessionSortKey(b).localeCompare(sessionSortKey(a)));
}

export function appendPeerConversationTranscript(
  input: AppendPeerConversationMessageInput
): PeerConversationSession {
  const tenantId = normalizeTenantId(input.tenantId);
  const localPeerId = normalizePeerId(input.localPeerId);
  const remotePeerId = normalizePeerId(input.remotePeerId);
  const sessionId = normalizeSessionId(input.sessionId);
  const session =
    loadPeerConversationSession(tenantId, localPeerId, sessionId) ||
    createPeerConversationSession({
      tenantId,
      sessionId,
      localPeerId,
      remotePeerId,
      topic: input.payload?.topic ? String(input.payload.topic) : input.kind,
      title: input.payload?.title ? String(input.payload.title) : undefined,
      relatedWorkItemIds: input.relatedWorkItemIds,
      metadata: input.metadata,
    });

  const entry: PeerConversationTranscriptEntry = {
    message_id: input.messageId || randomId('PCM'),
    kind: input.kind,
    direction: input.direction,
    sender_peer_id: input.direction === 'outbound' ? localPeerId : remotePeerId,
    recipient_peer_id: input.direction === 'outbound' ? remotePeerId : localPeerId,
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
    ...new Set(
      [
        ...session.related_work_item_ids,
        ...(input.relatedWorkItemIds || []),
        ...((input.payload?.related_work_item_ids as string[] | undefined) || []),
      ].filter(Boolean)
    ),
  ];
  session.status =
    input.kind === 'close' ? 'closed' : input.kind === 'handoff' ? 'active' : 'active';
  session.last_message_at = entry.created_at;
  session.updated_at = entry.created_at;
  savePeerConversationSession(session);
  recordEvent(tenantId, localPeerId, {
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
  tenantId: string;
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
      tenant_id: input.tenantId,
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
    tenantId: input.tenantId,
    sharedSecret: input.sharedSecret,
    conversationId: input.sessionId,
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    ...(typeof input.ttlMs === 'number' ? { ttlMs: input.ttlMs } : {}),
  });
}

export async function sendPeerConversationMessageToPeer(
  input: SendPeerConversationMessageInput
): Promise<{
  session: PeerConversationSession;
  receipt: PeerMessageDispatchReceipt;
}> {
  const catalog = loadPeerNetworkCatalog({
    ...(input.catalogPath ? { catalogPath: input.catalogPath } : {}),
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
  });
  const target = resolvePeerDispatchTarget(input.recipientPeerId, catalog);
  const sessionId = input.sessionId || randomId('PCS');
  const localSession = appendPeerConversationTranscript({
    tenantId: input.tenantId,
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
    tenantId: input.tenantId,
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

  const response = receipt.response;
  let responseRecord: Record<string, unknown> | undefined;
  if (response !== undefined && !isRecord(response)) {
    throw new Error('invalid_peer_conversation_response');
  }
  if (response !== undefined) responseRecord = response as Record<string, unknown>;
  if (responseRecord?.reply !== undefined) {
    const reply = parsePeerConversationTranscriptEntry(responseRecord.reply);
    if (
      reply.sender_peer_id !== input.recipientPeerId ||
      reply.recipient_peer_id !== input.senderPeerId
    ) {
      throw new Error('peer_conversation_reply_identity_mismatch');
    }
    appendPeerConversationTranscript({
      tenantId: input.tenantId,
      sessionId,
      localPeerId: input.senderPeerId,
      remotePeerId: input.recipientPeerId,
      kind: reply.kind,
      direction: 'inbound',
      text: reply.text,
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
    session:
      loadPeerConversationSession(input.tenantId, input.senderPeerId, sessionId) || localSession,
    receipt,
  };
}

export function clearPeerConversationRuntime(tenantId: string, peerId: string): void {
  withExecutionContext(GOVERNED_ROLE, () => {
    const runtimeDir = peerRoot(tenantId, peerId);
    const observabilityDir = path.dirname(eventsPath(tenantId, peerId));
    if (safeExistsSync(runtimeDir)) safeRmSync(runtimeDir, { recursive: true, force: true });
    if (safeExistsSync(observabilityDir))
      safeRmSync(observabilityDir, { recursive: true, force: true });
  });
}

export function createPeerConversationResponder(
  options: CreatePeerConversationResponderOptions
): PeerMessageResponder {
  const responderPeerId = normalizePeerId(options.peerId);
  const responderTenantId = normalizeTenantId(options.tenantId);
  return async (context: PeerMessageResponderContext): Promise<unknown> => {
    if (context.envelope.tenant_id !== responderTenantId) {
      throw new Error(`peer_conversation_tenant_mismatch:${context.envelope.message_id}`);
    }
    const payload = validatePeerConversationMessage(context.envelope.payload);
    if (!payload.valid || !payload.value) {
      throw new Error(`invalid_peer_conversation_message:${payload.errors.join('; ')}`);
    }

    const message = payload.value;
    if (message.tenant_id !== context.envelope.tenant_id) {
      throw new Error(`peer_conversation_tenant_mismatch:${message.session_id}`);
    }
    const session = appendPeerConversationTranscript({
      tenantId: responderTenantId,
      sessionId: message.session_id,
      localPeerId: responderPeerId,
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
        tenant_id: message.tenant_id,
      },
      messageId: context.envelope.message_id,
    });

    const maybeReply = (await options.onMessage?.({
      session,
      message: session.transcript[session.transcript.length - 1],
      envelope: context.envelope,
    })) as Partial<PeerConversationResponderResult> | void;

    const replyResult = maybeReply as Partial<PeerConversationResponderResult> | undefined;
    const suppliedReply = replyResult?.reply;
    const reply = suppliedReply
      ? parsePeerConversationTranscriptEntry(suppliedReply)
      : parsePeerConversationTranscriptEntry({
          message_id: randomId('PCR'),
          kind: message.message_kind === 'close' ? 'close' : 'reply',
          direction: 'outbound',
          sender_peer_id: responderPeerId,
          recipient_peer_id: context.envelope.sender_peer_id,
          text: `Received by ${responderPeerId}: ${message.text}`,
          created_at: nowIso(),
          ...(message.related_work_item_ids?.length
            ? { related_work_item_ids: [...new Set(message.related_work_item_ids)] }
            : {}),
          ...(message.reply_to_message_id
            ? { reply_to_message_id: message.reply_to_message_id }
            : {}),
          payload: {
            conversation_session_id: session.session_id,
            peer_id: responderPeerId,
          },
        });
    if (
      reply.sender_peer_id !== responderPeerId ||
      reply.recipient_peer_id !== context.envelope.sender_peer_id
    ) {
      throw new Error('peer_conversation_reply_identity_mismatch');
    }

    const updatedSession = appendPeerConversationTranscript({
      tenantId: responderTenantId,
      sessionId: message.session_id,
      localPeerId: responderPeerId,
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
