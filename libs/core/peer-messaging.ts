import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as http from 'node:http';

import { logger } from './core.js';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { appendGovernedArtifactJsonl, type GovernedArtifactRole } from './artifact-store.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile, validateUrl } from './secure-io.js';

export type PeerMessageType =
  | 'request'
  | 'reply'
  | 'notification'
  | 'handoff'
  | 'capability_query'
  | 'capability_response';

export interface PeerMessageEnvelope<TPayload = unknown> {
  version: '1';
  message_id: string;
  conversation_id: string;
  type: PeerMessageType;
  sender_peer_id: string;
  recipient_peer_id: string;
  subject: string;
  payload: TPayload;
  created_at: string;
  reply_to_message_id?: string;
  correlation_id?: string;
  ttl_ms?: number;
  expires_at?: string;
  transport?: 'http';
  signature?: string;
}

export interface PeerNetworkPeerRecord {
  peer_id: string;
  base_url: string;
  shared_secret?: string;
  allow_local_network?: boolean;
  capabilities?: string[];
  description?: string;
}

export interface PeerNetworkCatalog {
  version: '1';
  peers: PeerNetworkPeerRecord[];
}

export interface BuildPeerMessageInput<TPayload = unknown> {
  senderPeerId: string;
  recipientPeerId: string;
  subject: string;
  type: PeerMessageType;
  payload: TPayload;
  sharedSecret: string;
  conversationId?: string;
  replyToMessageId?: string;
  correlationId?: string;
  ttlMs?: number;
}

export interface PeerMessageDispatchOptions {
  destinationUrl: string;
  allowLocalNetwork?: boolean;
  timeoutMs?: number;
}

export interface ResolvedPeerDispatchTarget {
  peer: PeerNetworkPeerRecord;
  destinationUrl: string;
  allowLocalNetwork: boolean;
  sharedSecret: string;
}

export interface PeerMessageDispatchReceipt {
  ok: boolean;
  status: number;
  accepted?: boolean;
  message_id: string;
  processing_mode?: 'synchronous_on_receive';
  processed_at?: string;
  response?: unknown;
  error?: string;
}

export interface PeerMessageResponderContext {
  peerId: string;
  envelope: PeerMessageEnvelope;
}

export type PeerMessageResponder = (context: PeerMessageResponderContext) => Promise<unknown> | unknown;

export interface PeerMessagingServerOptions {
  peerId: string;
  sharedSecret: string;
  responder?: PeerMessageResponder;
  inboxRole?: GovernedArtifactRole;
  eventRole?: GovernedArtifactRole;
}

export interface PeerMessagingCatalogOptions {
  catalogPath?: string;
}

const DEFAULT_CATALOG_PATH = pathResolver.knowledge('public/orchestration/peer-network.json');
const DEFAULT_RUNTIME_ROOT = 'active/shared/runtime/peer-messaging';
const DEFAULT_OBSERVABILITY_ROOT = 'active/shared/observability/peer-messaging';
const DEFAULT_INBOX_ROLE: GovernedArtifactRole = 'surface_runtime';
const DEFAULT_EVENT_ROLE: GovernedArtifactRole = 'infrastructure_sentinel';

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function normalizeEnvelope<TPayload>(envelope: PeerMessageEnvelope<TPayload>): PeerMessageEnvelope<TPayload> {
  return {
    version: envelope.version || '1',
    message_id: envelope.message_id,
    conversation_id: envelope.conversation_id,
    type: envelope.type,
    sender_peer_id: envelope.sender_peer_id,
    recipient_peer_id: envelope.recipient_peer_id,
    subject: envelope.subject,
    payload: envelope.payload,
    created_at: envelope.created_at,
    ...(envelope.reply_to_message_id ? { reply_to_message_id: envelope.reply_to_message_id } : {}),
    ...(envelope.correlation_id ? { correlation_id: envelope.correlation_id } : {}),
    ...(typeof envelope.ttl_ms === 'number' ? { ttl_ms: envelope.ttl_ms } : {}),
    ...(envelope.expires_at ? { expires_at: envelope.expires_at } : {}),
    ...(envelope.transport ? { transport: envelope.transport } : {}),
    ...(envelope.signature ? { signature: envelope.signature } : {}),
  };
}

function signaturePayload<TPayload>(envelope: PeerMessageEnvelope<TPayload>): Record<string, unknown> {
  return {
    version: envelope.version || '1',
    message_id: envelope.message_id,
    conversation_id: envelope.conversation_id,
    type: envelope.type,
    sender_peer_id: envelope.sender_peer_id,
    recipient_peer_id: envelope.recipient_peer_id,
    subject: envelope.subject,
    payload: envelope.payload,
    created_at: envelope.created_at,
    ...(envelope.reply_to_message_id ? { reply_to_message_id: envelope.reply_to_message_id } : {}),
    ...(envelope.correlation_id ? { correlation_id: envelope.correlation_id } : {}),
    ...(typeof envelope.ttl_ms === 'number' ? { ttl_ms: envelope.ttl_ms } : {}),
    ...(envelope.expires_at ? { expires_at: envelope.expires_at } : {}),
    ...(envelope.transport ? { transport: envelope.transport } : {}),
  };
}

export function signPeerMessage<TPayload>(
  envelope: PeerMessageEnvelope<TPayload>,
  sharedSecret: string,
): string {
  return crypto
    .createHmac('sha256', sharedSecret)
    .update(JSON.stringify(signaturePayload(envelope)))
    .digest('hex');
}

export function verifyPeerMessage<TPayload>(
  envelope: PeerMessageEnvelope<TPayload>,
  sharedSecret: string,
): boolean {
  if (!envelope.signature) return false;
  const expected = signPeerMessage(envelope, sharedSecret);
  if (expected.length !== envelope.signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(envelope.signature, 'hex'));
}

export function buildPeerMessageEnvelope<TPayload>(
  input: BuildPeerMessageInput<TPayload>,
): PeerMessageEnvelope<TPayload> {
  const envelope: PeerMessageEnvelope<TPayload> = {
    version: '1',
    message_id: randomId('PM'),
    conversation_id: input.conversationId || randomId('PC'),
    type: input.type,
    sender_peer_id: input.senderPeerId,
    recipient_peer_id: input.recipientPeerId,
    subject: input.subject,
    payload: input.payload,
    created_at: nowIso(),
    ...(input.replyToMessageId ? { reply_to_message_id: input.replyToMessageId } : {}),
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    ...(typeof input.ttlMs === 'number' ? { ttl_ms: input.ttlMs, expires_at: new Date(Date.now() + input.ttlMs).toISOString() } : {}),
    transport: 'http',
  };
  envelope.signature = signPeerMessage(envelope, input.sharedSecret);
  return envelope;
}

export function loadPeerNetworkCatalog(
  options: PeerMessagingCatalogOptions = {},
): PeerNetworkCatalog | null {
  const catalogPath = options.catalogPath || process.env.KYBERION_PEER_NETWORK_CATALOG || DEFAULT_CATALOG_PATH;
  try {
    if (!safeExistsSync(catalogPath)) return null;
    const raw = safeReadFile(catalogPath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as PeerNetworkCatalog;
    if (parsed && parsed.version === '1' && Array.isArray(parsed.peers)) {
      return parsed;
    }
  } catch (error: any) {
    logger.warn(`[peer-messaging] failed to load catalog ${catalogPath}: ${error?.message || error}`);
  }
  return null;
}

export function resolvePeerRecord(
  peerId: string,
  catalog: PeerNetworkCatalog | null = loadPeerNetworkCatalog(),
): PeerNetworkPeerRecord | null {
  const normalizedPeerId = String(peerId || '').trim();
  if (!normalizedPeerId) return null;
  const peer = catalog?.peers?.find((entry) => entry.peer_id === normalizedPeerId) || null;
  return peer || null;
}

export function resolvePeerDispatchTarget(
  peerId: string,
  catalog: PeerNetworkCatalog | null = loadPeerNetworkCatalog(),
): ResolvedPeerDispatchTarget {
  const peer = resolvePeerRecord(peerId, catalog);
  if (!peer) {
    throw new Error(`peer_not_found:${peerId}`);
  }
  if (!peer.base_url) {
    throw new Error(`peer_missing_base_url:${peerId}`);
  }
  if (!peer.shared_secret) {
    throw new Error(`peer_missing_shared_secret:${peerId}`);
  }
  return {
    peer,
    destinationUrl: peer.base_url,
    allowLocalNetwork: peer.allow_local_network !== false,
    sharedSecret: peer.shared_secret,
  };
}

function runtimeLogicalPath(peerId: string, segment: string): string {
  return `${DEFAULT_RUNTIME_ROOT}/${peerId}/${segment}`;
}

function observabilityLogicalPath(peerId: string, segment: string): string {
  return `${DEFAULT_OBSERVABILITY_ROOT}/${peerId}/${segment}`;
}

function appendRuntimeJsonl(role: GovernedArtifactRole, peerId: string, segment: string, record: unknown): string {
  return appendGovernedArtifactJsonl(role, runtimeLogicalPath(peerId, segment), record);
}

function appendObservabilityJsonl(role: GovernedArtifactRole, peerId: string, segment: string, record: unknown): string {
  return appendGovernedArtifactJsonl(role, observabilityLogicalPath(peerId, segment), record);
}

function readJsonlRecords<T>(logicalPath: string): T[] {
  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) return [];
  const raw = String(safeReadFile(resolved, { encoding: 'utf8' }) || '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function listPeerInboxRecords(peerId: string): Array<Record<string, unknown>> {
  return readJsonlRecords<Record<string, unknown>>(runtimeLogicalPath(peerId, 'inbox.jsonl'));
}

export function listPeerOutboxRecords(peerId: string): Array<Record<string, unknown>> {
  return readJsonlRecords<Record<string, unknown>>(runtimeLogicalPath(peerId, 'outbox.jsonl'));
}

export function listPeerEvents(peerId: string): Array<Record<string, unknown>> {
  return readJsonlRecords<Record<string, unknown>>(observabilityLogicalPath(peerId, 'events.jsonl'));
}

export function clearPeerRuntime(peerId: string): void {
  const runtimeDir = pathResolver.resolve(`${DEFAULT_RUNTIME_ROOT}/${peerId}`);
  const observabilityDir = pathResolver.resolve(`${DEFAULT_OBSERVABILITY_ROOT}/${peerId}`);
  withExecutionContext('infrastructure_sentinel', () => {
    if (safeExistsSync(runtimeDir)) safeRmSync(runtimeDir, { recursive: true, force: true });
    if (safeExistsSync(observabilityDir)) safeRmSync(observabilityDir, { recursive: true, force: true });
  });
}

function recordPeerEvent(
  peerId: string,
  event: Record<string, unknown>,
  role: GovernedArtifactRole = DEFAULT_EVENT_ROLE,
): string {
  return appendObservabilityJsonl(role, peerId, 'events.jsonl', {
    ts: nowIso(),
    peer_id: peerId,
    ...event,
  });
}

function recordInbox(
  peerId: string,
  envelope: PeerMessageEnvelope,
  role: GovernedArtifactRole = DEFAULT_INBOX_ROLE,
): string {
  return appendRuntimeJsonl(role, peerId, 'inbox.jsonl', {
    received_at: nowIso(),
    envelope,
  });
}

function recordOutbox(
  peerId: string,
  envelope: PeerMessageEnvelope,
  destinationUrl: string,
  status: 'sent' | 'failed',
  response?: unknown,
  error?: string,
  role: GovernedArtifactRole = DEFAULT_INBOX_ROLE,
): string {
  return appendRuntimeJsonl(role, peerId, 'outbox.jsonl', {
    sent_at: nowIso(),
    destination_url: destinationUrl,
    status,
    envelope,
    ...(response !== undefined ? { response } : {}),
    ...(error ? { error } : {}),
  });
}

function parseRequestBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export class PeerMessagingServer {
  private server: http.Server | null = null;

  constructor(private readonly options: PeerMessagingServerOptions) {}

  public async processEnvelope(envelope: PeerMessageEnvelope): Promise<{ status: number; body: unknown }> {
    const normalized = normalizeEnvelope(envelope);
    const sharedSecret = this.options.sharedSecret;
    if (!normalized || typeof normalized !== 'object') {
      return { status: 400, body: { ok: false, error: 'invalid_envelope' } };
    }
    if (normalized.recipient_peer_id !== this.options.peerId) {
      recordPeerEvent(this.options.peerId, {
        type: 'message_rejected',
        message_id: normalized.message_id,
        reason: 'recipient_mismatch',
        sender_peer_id: normalized.sender_peer_id,
        recipient_peer_id: normalized.recipient_peer_id,
      });
      return { status: 400, body: { ok: false, error: 'recipient_mismatch' } };
    }
    if (!verifyPeerMessage(normalized, sharedSecret)) {
      recordPeerEvent(this.options.peerId, {
        type: 'message_rejected',
        message_id: normalized.message_id,
        reason: 'invalid_signature',
        sender_peer_id: normalized.sender_peer_id,
        recipient_peer_id: normalized.recipient_peer_id,
      });
      return { status: 401, body: { ok: false, error: 'invalid_signature' } };
    }

    recordInbox(this.options.peerId, normalized, this.options.inboxRole);
    recordPeerEvent(this.options.peerId, {
      type: 'message_received',
      message_id: normalized.message_id,
      conversation_id: normalized.conversation_id,
      message_type: normalized.type,
      sender_peer_id: normalized.sender_peer_id,
      recipient_peer_id: normalized.recipient_peer_id,
      subject: normalized.subject,
    });

    const processedAt = nowIso();
    let response: unknown = { accepted: true };
    if (this.options.responder) {
      response = await this.options.responder({ peerId: this.options.peerId, envelope: normalized });
    }

    recordPeerEvent(this.options.peerId, {
      type: 'message_handled',
      message_id: normalized.message_id,
      conversation_id: normalized.conversation_id,
      message_type: normalized.type,
      processing_mode: 'synchronous_on_receive',
      processed_at: processedAt,
    });

    return {
      status: 200,
      body: {
        ok: true,
        accepted: true,
        processing_mode: 'synchronous_on_receive',
        processed_at: processedAt,
        peer_id: this.options.peerId,
        message_id: normalized.message_id,
        response,
      },
    };
  }

  async listen(port: number, host = '127.0.0.1'): Promise<http.Server> {
    if (this.server) return this.server;
    const server = http.createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && req.url === '/health') {
          return sendJson(res, 200, {
            ok: true,
            peer_id: this.options.peerId,
            pid: process.pid,
          });
        }

        if (req.method === 'GET' && req.url === '/v1/peer/messages/inbox') {
          return sendJson(res, 200, {
            ok: true,
            items: listPeerInboxRecords(this.options.peerId),
          });
        }

        if (req.method === 'GET' && req.url === '/v1/peer/messages/outbox') {
          return sendJson(res, 200, {
            ok: true,
            items: listPeerOutboxRecords(this.options.peerId),
          });
        }

        if (req.method !== 'POST' || req.url !== '/v1/peer/messages') {
          return sendJson(res, 404, { ok: false, error: 'not_found' });
        }

        const body = await parseRequestBody(req);
        const result = await this.processEnvelope(body as PeerMessageEnvelope);
        return sendJson(res, result.status, result.body);
      } catch (error: any) {
        recordPeerEvent(this.options.peerId, {
          type: 'message_error',
          reason: error?.message || String(error),
        });
        return sendJson(res, 500, { ok: false, error: error?.message || String(error) });
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    logger.info(`[peer-messaging] listening for peer ${this.options.peerId} on http://${host}:${port}`);
    return server;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

export async function sendPeerMessage<TPayload>(
  envelope: PeerMessageEnvelope<TPayload>,
  options: PeerMessageDispatchOptions,
): Promise<PeerMessageDispatchReceipt> {
  const destinationUrl = validateUrl(options.destinationUrl, { allowLocalNetwork: options.allowLocalNetwork !== false });
  const url = `${destinationUrl.replace(/\/$/, '')}/v1/peer/messages`;
  const request = fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });

  const outboxPeerId = envelope.sender_peer_id;
  try {
    const response = await request;
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (response.ok) {
      recordOutbox(outboxPeerId, envelope, destinationUrl, 'sent', payload);
    } else {
      recordOutbox(
        outboxPeerId,
        envelope,
        destinationUrl,
        'failed',
        payload,
        payload?.error ? String(payload.error) : `http_${response.status}`,
      );
    }
    return {
      ok: response.ok,
      status: response.status,
      accepted: Boolean(payload?.accepted),
      message_id: envelope.message_id,
      processing_mode: payload?.processing_mode === 'synchronous_on_receive' ? 'synchronous_on_receive' : undefined,
      processed_at: typeof payload?.processed_at === 'string' ? payload.processed_at : undefined,
      response: payload?.response,
      error: payload?.error ? String(payload.error) : undefined,
    };
  } catch (error: any) {
    recordOutbox(
      outboxPeerId,
      envelope,
      destinationUrl,
      'failed',
      null,
      error?.message || String(error),
    );
    throw error;
  }
}

export async function sendPeerMessageToPeer<TPayload>(
  peerId: string,
  envelope: PeerMessageEnvelope<TPayload>,
  options: {
    catalog?: PeerNetworkCatalog | null;
    timeoutMs?: number;
  } = {},
): Promise<PeerMessageDispatchReceipt> {
  const target = resolvePeerDispatchTarget(peerId, options.catalog);
  return sendPeerMessage(envelope, {
    destinationUrl: target.destinationUrl,
    allowLocalNetwork: target.allowLocalNetwork,
    timeoutMs: options.timeoutMs,
  });
}

export function createPeerMessagingServer(options: PeerMessagingServerOptions): PeerMessagingServer {
  return new PeerMessagingServer(options);
}

export function createPeerMessageRequest<TPayload = unknown>(
  input: Omit<BuildPeerMessageInput<TPayload>, 'type'>,
): PeerMessageEnvelope<TPayload> {
  return buildPeerMessageEnvelope({
    ...input,
    type: 'request',
  });
}

export function createPeerMessageNotification<TPayload = unknown>(
  input: Omit<BuildPeerMessageInput<TPayload>, 'type'>,
): PeerMessageEnvelope<TPayload> {
  return buildPeerMessageEnvelope({
    ...input,
    type: 'notification',
  });
}

export function ensurePeerRuntimeDir(peerId: string): string {
  const resolved = pathResolver.resolve(runtimeLogicalPath(peerId, 'state.json'));
  const dir = path.dirname(resolved);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
  return dir;
}

export function persistPeerRuntimeState(peerId: string, state: Record<string, unknown>): string {
  const logicalPath = runtimeLogicalPath(peerId, 'state.json');
  safeWriteFile(logicalPath, JSON.stringify(state, null, 2));
  return pathResolver.resolve(logicalPath);
}
