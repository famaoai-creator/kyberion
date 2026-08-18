import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as http from 'node:http';

import { logger } from './core.js';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { appendGovernedArtifactJsonl, type GovernedArtifactRole } from './artifact-store.js';
import { isValidTenantSlug } from './entity-scope.js';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';
import { toWireError } from './wire-error.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  validateUrl,
} from './secure-io.js';

export type PeerMessageType =
  'request' | 'reply' | 'notification' | 'handoff' | 'capability_query' | 'capability_response';

export interface PeerMessageEnvelope<TPayload = unknown> {
  version: '1';
  tenant_id: string;
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
  /** Canonical request scope carried inside the signed peer envelope. */
  scope: EventScope;
  /** Optional NHI principal; peer identity alone is not an authority grant. */
  principal?: { kind: 'nhi'; id: string };
  /** Required for brokered cross-tenant extensions; same-tenant messages omit it. */
  approval_ref?: string;
}

export interface PeerNetworkPeerRecord {
  peer_id: string;
  base_url: string;
  shared_secret?: string;
  exposure?: PeerNetworkExposure;
  allow_local_network?: boolean;
  capabilities?: string[];
  description?: string;
}

export type PeerNetworkExposure = 'same_host' | 'same_lan' | 'private_network' | 'public_network';

export type PeerNetworkCatalogVisibility =
  'operator_only' | 'tenant_confidential' | 'public_metadata';

export interface PeerNetworkCatalog {
  version: '1';
  tenant_id?: string;
  catalog_visibility?: PeerNetworkCatalogVisibility;
  peers: PeerNetworkPeerRecord[];
}

export interface BuildPeerMessageInput<TPayload = unknown> {
  tenantId: string;
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
  scope?: EventScopeInput;
  principal?: { kind: 'nhi'; id: string };
  approvalRef?: string;
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

export type PeerMessageResponder = (
  context: PeerMessageResponderContext
) => Promise<unknown> | unknown;

export interface PeerMessagingServerOptions {
  peerId: string;
  tenantId: string;
  sharedSecret: string;
  responder?: PeerMessageResponder;
  inboxRole?: GovernedArtifactRole;
  eventRole?: GovernedArtifactRole;
}

export interface PeerMessagingCatalogOptions {
  catalogPath?: string;
  tenantId?: string;
}

const DEFAULT_CATALOG_PATH = pathResolver.knowledge('product/orchestration/peer-network.json');
const DEFAULT_RUNTIME_ROOT = 'active/shared/runtime/peer-messaging';
const DEFAULT_OBSERVABILITY_ROOT = 'active/shared/observability/peer-messaging';
const DEFAULT_INBOX_ROLE: GovernedArtifactRole = 'surface_runtime';
const DEFAULT_EVENT_ROLE: GovernedArtifactRole = 'infrastructure_sentinel';
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const REQUEST_SIGNATURE_HEADER = 'x-kyberion-peer-signature';
const PEER_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::', '::1']);

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function normalizeEnvelope<TPayload>(
  envelope: PeerMessageEnvelope<TPayload>
): PeerMessageEnvelope<TPayload> {
  return {
    version: envelope.version || '1',
    tenant_id: envelope.tenant_id,
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
    scope: envelope.scope,
    ...(envelope.principal ? { principal: envelope.principal } : {}),
    ...(envelope.approval_ref ? { approval_ref: envelope.approval_ref } : {}),
  };
}

function signaturePayload<TPayload>(
  envelope: PeerMessageEnvelope<TPayload>
): Record<string, unknown> {
  return {
    version: envelope.version || '1',
    tenant_id: envelope.tenant_id,
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
    scope: envelope.scope,
    ...(envelope.principal ? { principal: envelope.principal } : {}),
    ...(envelope.approval_ref ? { approval_ref: envelope.approval_ref } : {}),
  };
}

export function signPeerMessage<TPayload>(
  envelope: PeerMessageEnvelope<TPayload>,
  sharedSecret: string
): string {
  return crypto
    .createHmac('sha256', sharedSecret)
    .update(JSON.stringify(signaturePayload(envelope)))
    .digest('hex');
}

export function verifyPeerMessage<TPayload>(
  envelope: PeerMessageEnvelope<TPayload>,
  sharedSecret: string
): boolean {
  if (!envelope.signature) return false;
  const expected = signPeerMessage(envelope, sharedSecret);
  if (expected.length !== envelope.signature.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(envelope.signature, 'hex')
  );
}

export function buildPeerMessageEnvelope<TPayload>(
  input: BuildPeerMessageInput<TPayload>
): PeerMessageEnvelope<TPayload> {
  const tenantId = normalizeTenantId(input.tenantId);
  const scope = normalizeEventScope(
    input.scope || { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenantId }
  );
  if (scope.tenant_slug !== tenantId) {
    throw new Error(`peer_message_scope_tenant_mismatch:${tenantId}`);
  }
  const envelope: PeerMessageEnvelope<TPayload> = {
    version: '1',
    tenant_id: tenantId,
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
    ...(typeof input.ttlMs === 'number'
      ? { ttl_ms: input.ttlMs, expires_at: new Date(Date.now() + input.ttlMs).toISOString() }
      : {}),
    transport: 'http',
    scope,
    ...(input.principal ? { principal: input.principal } : {}),
    ...(input.approvalRef ? { approval_ref: input.approvalRef } : {}),
  };
  envelope.signature = signPeerMessage(envelope, input.sharedSecret);
  return envelope;
}

export function loadPeerNetworkCatalog(
  options: PeerMessagingCatalogOptions = {}
): PeerNetworkCatalog | null {
  if (options.tenantId) normalizeTenantId(options.tenantId);
  const catalogPath = resolvePeerNetworkCatalogPath(options);
  try {
    if (!safeExistsSync(catalogPath)) return null;
    const raw = safeReadFile(catalogPath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as PeerNetworkCatalog;
    if (parsed && parsed.version === '1' && Array.isArray(parsed.peers)) {
      if (parsed.tenant_id && !isValidTenantSlug(parsed.tenant_id)) {
        throw new Error(`peer_catalog_invalid_tenant:${parsed.tenant_id}`);
      }
      if (options.tenantId && parsed.tenant_id !== options.tenantId) {
        throw new Error(`peer_catalog_tenant_mismatch:${options.tenantId}`);
      }
      if (
        parsed.catalog_visibility === 'public_metadata' &&
        parsed.peers.some((peer) => Boolean(peer.shared_secret))
      ) {
        throw new Error('public_peer_catalog_contains_shared_secret');
      }
      return parsed;
    }
  } catch (error: any) {
    logger.warn(
      `[peer-messaging] failed to load catalog ${catalogPath}: ${error?.message || error}`
    );
  }
  return null;
}

function normalizeTenantId(tenantId: string): string {
  const normalized = String(tenantId || '').trim();
  if (!isValidTenantSlug(normalized)) {
    throw new Error(`invalid_peer_network_tenant_id:${normalized || 'missing'}`);
  }
  return normalized;
}

export function peerNetworkCatalogPath(tenantId: string): string {
  return pathResolver.knowledge(
    `confidential/${normalizeTenantId(tenantId)}/connections/peer-network.json`
  );
}

export function resolvePeerNetworkCatalogPath(options: PeerMessagingCatalogOptions = {}): string {
  if (options.catalogPath) return options.catalogPath;
  if (process.env.KYBERION_PEER_NETWORK_CATALOG?.trim()) {
    return process.env.KYBERION_PEER_NETWORK_CATALOG.trim();
  }
  const tenantId = options.tenantId?.trim() || process.env.KYBERION_TENANT_ID?.trim();
  return tenantId ? peerNetworkCatalogPath(tenantId) : DEFAULT_CATALOG_PATH;
}

export interface RegisterPeerNetworkPeerInput {
  tenantId: string;
  peerId: string;
  baseUrl: string;
  sharedSecret: string;
  exposure: PeerNetworkExposure;
  /** Test-only fixture seam; production registration always uses the tenant confidential path. */
  catalogPath?: string;
  capabilities?: string[];
  description?: string;
}

export interface RegisterPeerNetworkPeerResult {
  catalogPath: string;
  catalog: PeerNetworkCatalog;
  peer: PeerNetworkPeerRecord;
}

function allowLocalNetworkForExposure(exposure: PeerNetworkExposure): boolean {
  return exposure !== 'public_network';
}

function validatePeerExposure(baseUrl: string, exposure: PeerNetworkExposure): void {
  const parsed = new URL(baseUrl);
  if (exposure === 'same_host' && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('same_host_requires_loopback_endpoint');
  }
  validateUrl(baseUrl, { allowLocalNetwork: allowLocalNetworkForExposure(exposure) });
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function registerPeerNetworkPeer(
  input: RegisterPeerNetworkPeerInput
): RegisterPeerNetworkPeerResult {
  const tenantId = normalizeTenantId(input.tenantId);
  const peerId = String(input.peerId || '').trim();
  if (!PEER_ID_PATTERN.test(peerId)) {
    throw new Error(`invalid_peer_network_peer_id:${peerId || 'missing'}`);
  }
  const sharedSecret = String(input.sharedSecret || '');
  if (sharedSecret.length < 8) {
    throw new Error(`peer_network_shared_secret_too_short:${peerId}`);
  }
  validatePeerExposure(input.baseUrl, input.exposure);

  const catalogPath = input.catalogPath || peerNetworkCatalogPath(tenantId);
  if (input.catalogPath) {
    const resolvedCatalogPath = pathResolver.resolve(input.catalogPath);
    const confidentialRoot = pathResolver.resolve(`knowledge/confidential/${tenantId}`);
    const sharedTmpRoot = pathResolver.resolve('active/shared/tmp');
    if (
      !isPathWithin(resolvedCatalogPath, confidentialRoot) &&
      !isPathWithin(resolvedCatalogPath, sharedTmpRoot)
    ) {
      throw new Error('peer_catalog_path_must_be_confidential_or_test_tmp');
    }
  }
  let catalog: PeerNetworkCatalog = {
    version: '1',
    tenant_id: tenantId,
    catalog_visibility: 'tenant_confidential',
    peers: [],
  };
  if (safeExistsSync(catalogPath)) {
    const raw = safeReadFile(catalogPath, { encoding: 'utf8' }) as string;
    const existing = JSON.parse(raw) as PeerNetworkCatalog;
    if (existing.version !== '1' || !Array.isArray(existing.peers)) {
      throw new Error(`invalid_peer_network_catalog:${catalogPath}`);
    }
    if (existing.tenant_id && existing.tenant_id !== tenantId) {
      throw new Error(`peer_catalog_tenant_mismatch:${tenantId}`);
    }
    if (existing.catalog_visibility === 'public_metadata') {
      throw new Error('cannot_register_secret_in_public_peer_catalog');
    }
    catalog = {
      ...existing,
      tenant_id: tenantId,
      catalog_visibility: 'tenant_confidential',
    };
  }

  const peer: PeerNetworkPeerRecord = {
    peer_id: peerId,
    base_url: input.baseUrl,
    shared_secret: sharedSecret,
    exposure: input.exposure,
    allow_local_network: allowLocalNetworkForExposure(input.exposure),
    ...(input.capabilities?.length ? { capabilities: [...new Set(input.capabilities)] } : {}),
    ...(input.description ? { description: input.description } : {}),
  };
  const peers = catalog.peers.filter((entry) => entry.peer_id !== peerId);
  catalog = {
    ...catalog,
    peers: [...peers, peer].sort((left, right) => left.peer_id.localeCompare(right.peer_id)),
  };
  safeMkdir(path.dirname(catalogPath), { recursive: true });
  safeWriteFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return { catalogPath, catalog, peer };
}

export function resolvePeerRecord(
  peerId: string,
  catalog: PeerNetworkCatalog | null = loadPeerNetworkCatalog()
): PeerNetworkPeerRecord | null {
  const normalizedPeerId = String(peerId || '').trim();
  if (!normalizedPeerId) return null;
  const peer = catalog?.peers?.find((entry) => entry.peer_id === normalizedPeerId) || null;
  return peer || null;
}

export function resolvePeerDispatchTarget(
  peerId: string,
  catalog: PeerNetworkCatalog | null = loadPeerNetworkCatalog()
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
    allowLocalNetwork:
      peer.allow_local_network ??
      (peer.exposure ? allowLocalNetworkForExposure(peer.exposure) : true),
    sharedSecret: peer.shared_secret,
  };
}

function runtimeLogicalPath(tenantId: string, peerId: string, segment: string): string {
  return `${DEFAULT_RUNTIME_ROOT}/tenants/${tenantId}/peers/${peerId}/${segment}`;
}

function observabilityLogicalPath(tenantId: string, peerId: string, segment: string): string {
  return `${DEFAULT_OBSERVABILITY_ROOT}/tenants/${tenantId}/peers/${peerId}/${segment}`;
}

function appendRuntimeJsonl(
  role: GovernedArtifactRole,
  tenantId: string,
  peerId: string,
  segment: string,
  record: unknown
): string {
  return appendGovernedArtifactJsonl(role, runtimeLogicalPath(tenantId, peerId, segment), record);
}

function appendObservabilityJsonl(
  role: GovernedArtifactRole,
  tenantId: string,
  peerId: string,
  segment: string,
  record: unknown
): string {
  return appendGovernedArtifactJsonl(
    role,
    observabilityLogicalPath(tenantId, peerId, segment),
    record
  );
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

export function listPeerInboxRecords(
  tenantId: string,
  peerId: string
): Array<Record<string, unknown>> {
  return readJsonlRecords<Record<string, unknown>>(
    runtimeLogicalPath(tenantId, peerId, 'inbox.jsonl')
  );
}

export function listPeerOutboxRecords(
  tenantId: string,
  peerId: string
): Array<Record<string, unknown>> {
  return readJsonlRecords<Record<string, unknown>>(
    runtimeLogicalPath(tenantId, peerId, 'outbox.jsonl')
  );
}

export function listPeerEvents(tenantId: string, peerId: string): Array<Record<string, unknown>> {
  return readJsonlRecords<Record<string, unknown>>(
    observabilityLogicalPath(tenantId, peerId, 'events.jsonl')
  );
}

export function clearPeerRuntime(tenantId: string, peerId: string): void {
  const runtimeDir = pathResolver.resolve(
    `${DEFAULT_RUNTIME_ROOT}/tenants/${tenantId}/peers/${peerId}`
  );
  const observabilityDir = pathResolver.resolve(
    `${DEFAULT_OBSERVABILITY_ROOT}/tenants/${tenantId}/peers/${peerId}`
  );
  withExecutionContext('infrastructure_sentinel', () => {
    if (safeExistsSync(runtimeDir)) safeRmSync(runtimeDir, { recursive: true, force: true });
    if (safeExistsSync(observabilityDir))
      safeRmSync(observabilityDir, { recursive: true, force: true });
  });
}

function recordPeerEvent(
  tenantId: string,
  peerId: string,
  event: Record<string, unknown>,
  role: GovernedArtifactRole = DEFAULT_EVENT_ROLE
): string {
  return appendObservabilityJsonl(role, tenantId, peerId, 'events.jsonl', {
    ts: nowIso(),
    peer_id: peerId,
    ...event,
  });
}

function recordInbox(
  tenantId: string,
  peerId: string,
  envelope: PeerMessageEnvelope,
  role: GovernedArtifactRole = DEFAULT_INBOX_ROLE
): string {
  return appendRuntimeJsonl(role, tenantId, peerId, 'inbox.jsonl', {
    received_at: nowIso(),
    envelope,
  });
}

function recordOutbox(
  tenantId: string,
  peerId: string,
  envelope: PeerMessageEnvelope,
  destinationUrl: string,
  status: 'sent' | 'failed',
  response?: unknown,
  error?: string,
  role: GovernedArtifactRole = DEFAULT_INBOX_ROLE
): string {
  return appendRuntimeJsonl(role, tenantId, peerId, 'outbox.jsonl', {
    sent_at: nowIso(),
    destination_url: destinationUrl,
    status,
    envelope,
    ...(response !== undefined ? { response } : {}),
    ...(error ? { error } : {}),
  });
}

export function signPeerHttpRequest(
  method: string,
  requestUrl: string,
  sharedSecret: string
): string {
  return crypto
    .createHmac('sha256', sharedSecret)
    .update(`${method.toUpperCase()}\n${requestUrl}`)
    .digest('hex');
}

function verifyPeerHttpRequest(req: http.IncomingMessage, sharedSecret: string): boolean {
  const signature = req.headers[REQUEST_SIGNATURE_HEADER];
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = signPeerHttpRequest(req.method || '', req.url || '', sharedSecret);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('request_body_too_large');
  }
}

function isRequestBodyTooLargeError(error: unknown): boolean {
  return (
    error instanceof RequestBodyTooLargeError ||
    (error instanceof Error && error.message === 'request_body_too_large')
  );
}

function parseRequestBody(
  req: http.IncomingMessage,
  maxBytes = MAX_REQUEST_BODY_BYTES
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      req.resume();
      reject(new RequestBodyTooLargeError());
      return;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > maxBytes) {
        settled = true;
        req.resume();
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
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

  constructor(private readonly options: PeerMessagingServerOptions) {
    normalizeTenantId(options.tenantId);
  }

  public async processEnvelope(
    envelope: PeerMessageEnvelope
  ): Promise<{ status: number; body: unknown }> {
    const normalized = normalizeEnvelope(envelope);
    const sharedSecret = this.options.sharedSecret;
    if (!normalized || typeof normalized !== 'object') {
      return { status: 400, body: { ok: false, error: 'invalid_envelope' } };
    }
    if (!normalized.tenant_id || !isValidTenantSlug(normalized.tenant_id)) {
      return { status: 400, body: { ok: false, error: 'invalid_tenant_id' } };
    }
    let scope: EventScope;
    try {
      scope = normalizeEventScope(normalized.scope);
    } catch {
      return { status: 400, body: { ok: false, error: 'invalid_scope' } };
    }
    if (scope.tenant_slug !== normalized.tenant_id) {
      return { status: 403, body: { ok: false, error: 'scope_tenant_mismatch' } };
    }
    if (normalized.tenant_id !== this.options.tenantId) {
      recordPeerEvent(this.options.tenantId, this.options.peerId, {
        type: 'message_rejected',
        message_id: normalized.message_id,
        reason: 'tenant_mismatch',
        envelope_tenant_id: normalized.tenant_id,
        receiver_tenant_id: this.options.tenantId,
        sender_peer_id: normalized.sender_peer_id,
      });
      return { status: 403, body: { ok: false, error: 'tenant_mismatch' } };
    }
    if (normalized.recipient_peer_id !== this.options.peerId) {
      recordPeerEvent(this.options.tenantId, this.options.peerId, {
        type: 'message_rejected',
        message_id: normalized.message_id,
        reason: 'recipient_mismatch',
        sender_peer_id: normalized.sender_peer_id,
        recipient_peer_id: normalized.recipient_peer_id,
      });
      return { status: 400, body: { ok: false, error: 'recipient_mismatch' } };
    }
    if (!verifyPeerMessage(normalized, sharedSecret)) {
      recordPeerEvent(this.options.tenantId, this.options.peerId, {
        type: 'message_rejected',
        message_id: normalized.message_id,
        reason: 'invalid_signature',
        sender_peer_id: normalized.sender_peer_id,
        recipient_peer_id: normalized.recipient_peer_id,
      });
      return { status: 401, body: { ok: false, error: 'invalid_signature' } };
    }

    recordInbox(this.options.tenantId, this.options.peerId, normalized, this.options.inboxRole);
    recordPeerEvent(this.options.tenantId, this.options.peerId, {
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
      try {
        response = await this.options.responder({
          peerId: this.options.peerId,
          envelope: normalized,
        });
      } catch (error) {
        const safe = toWireError(error, normalized.correlation_id);
        recordPeerEvent(this.options.tenantId, this.options.peerId, {
          type: 'message_error',
          message_id: normalized.message_id,
          reason: safe.code,
        });
        return {
          status: 500,
          body: {
            ok: false,
            error: safe.message,
            error_code: safe.code,
            correlation_id: safe.correlation_id,
          },
        };
      }
    }

    recordPeerEvent(this.options.tenantId, this.options.peerId, {
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
          return sendJson(res, 200, { ok: true });
        }

        if (req.method === 'GET' && req.url === '/v1/peer/messages/inbox') {
          if (!verifyPeerHttpRequest(req, this.options.sharedSecret)) {
            return sendJson(res, 401, { ok: false, error: 'invalid_request_signature' });
          }
          return sendJson(res, 200, {
            ok: true,
            items: listPeerInboxRecords(this.options.tenantId, this.options.peerId),
          });
        }

        if (req.method === 'GET' && req.url === '/v1/peer/messages/outbox') {
          if (!verifyPeerHttpRequest(req, this.options.sharedSecret)) {
            return sendJson(res, 401, { ok: false, error: 'invalid_request_signature' });
          }
          return sendJson(res, 200, {
            ok: true,
            items: listPeerOutboxRecords(this.options.tenantId, this.options.peerId),
          });
        }

        if (req.method !== 'POST' || req.url !== '/v1/peer/messages') {
          return sendJson(res, 404, { ok: false, error: 'not_found' });
        }

        const body = await parseRequestBody(req);
        const result = await this.processEnvelope(body as PeerMessageEnvelope);
        return sendJson(res, result.status, result.body);
      } catch (error: any) {
        if (isRequestBodyTooLargeError(error)) {
          return sendJson(res, 413, { ok: false, error: 'request_body_too_large' });
        }
        const safe = toWireError(error);
        recordPeerEvent(this.options.tenantId, this.options.peerId, {
          type: 'message_error',
          reason: safe.code,
        });
        return sendJson(res, 500, {
          ok: false,
          error: safe.message,
          error_code: safe.code,
          correlation_id: safe.correlation_id,
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    logger.info(
      `[peer-messaging] listening for peer ${this.options.peerId} on http://${host}:${port}`
    );
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
  options: PeerMessageDispatchOptions
): Promise<PeerMessageDispatchReceipt> {
  const destinationUrl = validateUrl(options.destinationUrl, {
    allowLocalNetwork: options.allowLocalNetwork !== false,
  });
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
      recordOutbox(envelope.tenant_id, outboxPeerId, envelope, destinationUrl, 'sent', payload);
    } else {
      recordOutbox(
        envelope.tenant_id,
        outboxPeerId,
        envelope,
        destinationUrl,
        'failed',
        payload,
        payload?.error ? String(payload.error) : `http_${response.status}`
      );
    }
    return {
      ok: response.ok,
      status: response.status,
      accepted: Boolean(payload?.accepted),
      message_id: envelope.message_id,
      processing_mode:
        payload?.processing_mode === 'synchronous_on_receive'
          ? 'synchronous_on_receive'
          : undefined,
      processed_at: typeof payload?.processed_at === 'string' ? payload.processed_at : undefined,
      response: payload?.response,
      error: payload?.error ? String(payload.error) : undefined,
    };
  } catch (error: any) {
    recordOutbox(
      envelope.tenant_id,
      outboxPeerId,
      envelope,
      destinationUrl,
      'failed',
      null,
      error?.message || String(error)
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
  } = {}
): Promise<PeerMessageDispatchReceipt> {
  const target = resolvePeerDispatchTarget(peerId, options.catalog);
  return sendPeerMessage(envelope, {
    destinationUrl: target.destinationUrl,
    allowLocalNetwork: target.allowLocalNetwork,
    timeoutMs: options.timeoutMs,
  });
}

export function createPeerMessagingServer(
  options: PeerMessagingServerOptions
): PeerMessagingServer {
  return new PeerMessagingServer(options);
}

export function createPeerMessageRequest<TPayload = unknown>(
  input: Omit<BuildPeerMessageInput<TPayload>, 'type'>
): PeerMessageEnvelope<TPayload> {
  return buildPeerMessageEnvelope({
    ...input,
    type: 'request',
  });
}

export function createPeerMessageNotification<TPayload = unknown>(
  input: Omit<BuildPeerMessageInput<TPayload>, 'type'>
): PeerMessageEnvelope<TPayload> {
  return buildPeerMessageEnvelope({
    ...input,
    type: 'notification',
  });
}

export function ensurePeerRuntimeDir(tenantId: string, peerId: string): string {
  const resolved = pathResolver.resolve(runtimeLogicalPath(tenantId, peerId, 'state.json'));
  const dir = path.dirname(resolved);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
  return dir;
}

export function persistPeerRuntimeState(
  tenantId: string,
  peerId: string,
  state: Record<string, unknown>
): string {
  const logicalPath = runtimeLogicalPath(tenantId, peerId, 'state.json');
  safeWriteFile(logicalPath, JSON.stringify(state, null, 2));
  return pathResolver.resolve(logicalPath);
}
