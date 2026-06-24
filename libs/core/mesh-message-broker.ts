import * as crypto from 'node:crypto';

import { withExecutionContext } from './authority.js';
import { appendGovernedArtifactJsonl, type GovernedArtifactRole } from './artifact-store.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import type {
  MeshDeliveryRecord,
  MeshDeliveryStatus,
  MeshFailureClass,
  MeshPayloadReference,
  MeshRequest,
  MeshRequestKind,
  MeshTargetSelector,
} from './mesh-hub-contract.js';

export interface MeshRetryPolicy {
  initial_delay_ms: number;
  max_delay_ms: number;
  max_attempts: number;
}

export interface MeshHubCommandLoopOptions {
  namespace?: string;
  writerRole?: GovernedArtifactRole;
}

export interface MeshHubAcceptResult {
  accepted: boolean;
  delivery: MeshDeliveryRecord;
  duplicate: boolean;
}

export interface MeshHubRouteDecision {
  request: MeshRequest;
  route?: MeshDeliveryRecord['route'];
  policy_version?: string;
  retry_policy?: Partial<MeshRetryPolicy>;
}

export interface MeshDeliveryReceipt {
  acknowledged_at?: string;
  completed?: boolean;
  redacted_reason?: string;
}

export interface MeshDeadLetterFilter {
  delivery_id?: string;
  request_id?: string;
  tenant_id?: string;
  failure_class?: MeshFailureClass;
  status?: MeshDeliveryStatus;
}

export interface MeshDeadLetterRecord {
  kind: 'mesh-dead-letter-record';
  dead_letter_id: string;
  delivery_id: string;
  request_id: string;
  tenant_scope: MeshRequest['tenant_scope'];
  request_kind: MeshRequestKind;
  target: {
    selector: MeshTargetSelector;
  };
  payload: MeshPayloadReference & {
    classification: MeshRequest['payload']['classification'];
  };
  attempt_count: number;
  status: MeshDeliveryStatus;
  failure_class: MeshFailureClass;
  redacted_reason: string;
  created_at: string;
}

interface MeshHubDeliveryRecord extends MeshDeliveryRecord {
  idempotency_key: string;
  expires_at: string;
}

const DEFAULT_POLICY_VERSION = '1.0.0';
const DEFAULT_RETRY_POLICY: MeshRetryPolicy = {
  initial_delay_ms: 1_000,
  max_delay_ms: 60_000,
  max_attempts: 5,
};
const DEFAULT_WRITER_ROLE: GovernedArtifactRole = 'infrastructure_sentinel';
const writerRegistry = new Map<string, string>();

function nowIso(): string {
  return new Date().toISOString();
}

function nowMs(iso: string): number {
  return new Date(iso).getTime();
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeNamespace(namespace?: string): string {
  return String(namespace || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function meshHubRoot(namespace?: string): string {
  const suffix = normalizeNamespace(namespace);
  return suffix ? `active/shared/runtime/mesh-hub/${suffix}` : 'active/shared/runtime/mesh-hub';
}

function meshHubObservabilityRoot(namespace?: string): string {
  const suffix = normalizeNamespace(namespace);
  return suffix ? `active/shared/observability/mesh-hub/${suffix}` : 'active/shared/observability/mesh-hub';
}

function deliveriesPath(namespace?: string): string {
  return `${meshHubRoot(namespace)}/deliveries.jsonl`;
}

function deadLettersPath(namespace?: string): string {
  return `${meshHubRoot(namespace)}/dead-letter.jsonl`;
}

function eventsPath(namespace?: string): string {
  return `${meshHubObservabilityRoot(namespace)}/events.jsonl`;
}

function payloadReference(payload: MeshRequest['payload']): MeshDeadLetterRecord['payload'] {
  return {
    classification: payload.classification,
    artifact_ref: payload.reference.artifact_ref,
    integrity_hash: payload.reference.integrity_hash,
    storage_class: payload.reference.storage_class,
  };
}

function selectorSummary(selector: MeshTargetSelector): Record<string, string> {
  switch (selector.kind) {
    case 'peer':
      return { selector_kind: selector.kind, peer_id: selector.peer_id };
    case 'role':
      return { selector_kind: selector.kind, role: selector.role };
    case 'capability':
      return {
        selector_kind: selector.kind,
        capability_id: selector.capability_id,
        ...(selector.version ? { version: selector.version } : {}),
      };
    case 'topic':
      return { selector_kind: selector.kind, topic: selector.topic };
    default:
      return { selector_kind: 'peer' };
  }
}

function readJsonl<T>(logicalPath: string): T[] {
  if (!safeExistsSync(logicalPath)) return [];
  const raw = String(safeReadFile(logicalPath, { encoding: 'utf8' }) || '');
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function latestByKey<T extends Record<string, any>>(rows: T[], key: string): T[] {
  const index = new Map<string, T>();
  for (const row of rows) {
    const value = row[key];
    if (typeof value === 'string' && value) {
      index.set(value, row);
    }
  }
  return Array.from(index.values());
}

function appendRecord(role: GovernedArtifactRole, logicalPath: string, record: unknown): string {
  return appendGovernedArtifactJsonl(role, logicalPath, record);
}

function loadCurrentDeliveries(namespace?: string): MeshHubDeliveryRecord[] {
  return latestByKey(readJsonl<MeshHubDeliveryRecord>(deliveriesPath(namespace)), 'delivery_id');
}

function loadCurrentDelivery(deliveryId: string, namespace?: string): MeshHubDeliveryRecord | null {
  const normalized = String(deliveryId || '').trim();
  if (!normalized) return null;
  return loadCurrentDeliveries(namespace).find((record) => record.delivery_id === normalized) || null;
}

function deliveryIdentity(request: MeshRequest): string {
  return crypto
    .createHash('sha256')
    .update(`${request.tenant_scope.tenant_id}:${request.idempotency_key}`)
    .digest('hex')
    .slice(0, 24);
}

function deliveryIdForRequest(request: MeshRequest): string {
  return `mhd-${deliveryIdentity(request)}`;
}

function findCurrentDeliveryByIdempotency(request: MeshRequest, namespace?: string): MeshHubDeliveryRecord | null {
  const deliveryId = deliveryIdForRequest(request);
  const current = loadCurrentDelivery(deliveryId, namespace);
  if (current) return current;
  return loadCurrentDeliveries(namespace).find((record) => record.idempotency_key === request.idempotency_key) || null;
}

function loadCurrentDeadLetters(namespace?: string): MeshDeadLetterRecord[] {
  return latestByKey(readJsonl<MeshDeadLetterRecord>(deadLettersPath(namespace)), 'dead_letter_id');
}

function recordEvent(
  namespace: string | undefined,
  event: Record<string, unknown>,
  role: GovernedArtifactRole,
): string {
  return appendRecord(role, eventsPath(namespace), {
    ts: nowIso(),
    ...event,
  });
}

function redactReason(reason: unknown): string {
  if (typeof reason === 'string') return reason.trim() || 'redacted';
  if (reason && typeof reason === 'object') {
    const entry = reason as Record<string, unknown>;
    const candidate = String(entry.redacted_reason || entry.code || entry.reason || '').trim();
    if (candidate) return candidate;
  }
  return 'redacted';
}

function normalizeRetryPolicy(input?: Partial<MeshRetryPolicy>): MeshRetryPolicy {
  return {
    initial_delay_ms: Math.max(0, Math.floor(input?.initial_delay_ms ?? DEFAULT_RETRY_POLICY.initial_delay_ms)),
    max_delay_ms: Math.max(0, Math.floor(input?.max_delay_ms ?? DEFAULT_RETRY_POLICY.max_delay_ms)),
    max_attempts: Math.max(1, Math.floor(input?.max_attempts ?? DEFAULT_RETRY_POLICY.max_attempts)),
  };
}

function nextRetryDelayMs(attemptCount: number, policy: MeshRetryPolicy): number {
  const exponent = Math.max(0, attemptCount - 1);
  const delay = policy.initial_delay_ms * (2 ** exponent);
  return Math.min(policy.max_delay_ms, delay);
}

function buildRoute(request: MeshRequest, policyVersion = DEFAULT_POLICY_VERSION): MeshDeliveryRecord['route'] {
  return {
    selector: request.target.selector,
    decision: 'direct',
    ...(request.target.selector.kind === 'peer' ? { selected_peer_id: request.target.selector.peer_id } : {}),
    selected_at: nowIso(),
    policy_version: policyVersion,
  };
}

function buildDeliverySnapshot(
  base: Omit<MeshDeliveryRecord, 'kind' | 'attempt_count' | 'status' | 'created_at'> & {
    attempt_count?: number;
    status?: MeshDeliveryStatus;
    created_at?: string;
    retry_at?: string;
    failure_class?: MeshFailureClass;
    idempotency_key?: string;
    expires_at?: string;
  },
): MeshHubDeliveryRecord {
  return {
    kind: 'mesh-delivery-record',
    delivery_id: base.delivery_id,
    message_id: base.message_id,
    request_id: base.request_id,
    tenant_scope: base.tenant_scope,
    request_kind: base.request_kind,
    target: { selector: base.target.selector },
    payload: {
      classification: base.payload.classification,
      reference: {
        artifact_ref: base.payload.reference.artifact_ref,
        integrity_hash: base.payload.reference.integrity_hash,
        storage_class: base.payload.reference.storage_class,
      },
    },
    attempt_count: base.attempt_count ?? 0,
    status: base.status ?? 'accepted',
    route: {
      selector: base.route.selector,
      decision: base.route.decision,
      ...(base.route.selected_peer_id ? { selected_peer_id: base.route.selected_peer_id } : {}),
      ...(base.route.selected_at ? { selected_at: base.route.selected_at } : {}),
      policy_version: base.route.policy_version,
    },
    created_at: base.created_at ?? nowIso(),
    idempotency_key: base.idempotency_key || 'unknown',
    expires_at: base.expires_at || base.created_at || nowIso(),
    ...(base.retry_at ? { retry_at: base.retry_at } : {}),
    ...(base.failure_class ? { failure_class: base.failure_class } : {}),
  };
}

function buildDeadLetter(snapshot: MeshDeliveryRecord, failureClass: MeshFailureClass, reason: unknown): MeshDeadLetterRecord {
  return {
    kind: 'mesh-dead-letter-record',
    dead_letter_id: randomId('mhdl'),
    delivery_id: snapshot.delivery_id,
    request_id: snapshot.request_id,
    tenant_scope: snapshot.tenant_scope,
    request_kind: snapshot.request_kind,
    target: { selector: snapshot.target.selector },
    payload: {
      classification: snapshot.payload.classification,
      artifact_ref: snapshot.payload.reference.artifact_ref,
      integrity_hash: snapshot.payload.reference.integrity_hash,
      storage_class: snapshot.payload.reference.storage_class,
    },
    attempt_count: snapshot.attempt_count,
    status: snapshot.status,
    failure_class: failureClass,
    redacted_reason: redactReason(reason),
    created_at: nowIso(),
  };
}

function validateFreshRequest(request: MeshRequest, now = nowIso()): void {
  const createdAt = nowMs(request.created_at);
  const expiresAt = createdAt + request.ttl_ms;
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    throw new Error(`mesh_request_invalid_timestamps:${request.request_id}`);
  }
  if (nowMs(now) >= expiresAt) {
    throw new Error(`mesh_request_expired:${request.request_id}`);
  }
}

function requestExpiryIso(request: MeshRequest): string {
  return new Date(nowMs(request.created_at) + request.ttl_ms).toISOString();
}

function writeDeliveryEvent(namespace: string | undefined, snapshot: MeshDeliveryRecord, eventType: string, role: GovernedArtifactRole): string {
  return recordEvent(namespace, {
    type: eventType,
    delivery_id: snapshot.delivery_id,
    request_id: snapshot.request_id,
    tenant_id: snapshot.tenant_scope.tenant_id,
    request_kind: snapshot.request_kind,
    status: snapshot.status,
    attempt_count: snapshot.attempt_count,
    retry_at: snapshot.retry_at,
    failure_class: snapshot.failure_class,
    ...selectorSummary(snapshot.target.selector),
    payload: {
      classification: snapshot.payload.classification,
      reference: snapshot.payload.reference,
    },
  }, role);
}

function claimWriter(namespace: string, token: string): void {
  const existing = writerRegistry.get(namespace);
  if (existing && existing !== token) {
    throw new Error(`mesh_hub_writer_fenced:${namespace}`);
  }
  writerRegistry.set(namespace, token);
}

function releaseWriter(namespace: string, token: string): void {
  if (writerRegistry.get(namespace) === token) {
    writerRegistry.delete(namespace);
  }
}

export class MeshHubCommandLoop {
  private readonly token = crypto.randomUUID();
  private tail: Promise<unknown> = Promise.resolve();
  private active = false;

  constructor(private readonly namespace = '', private readonly writerRole: GovernedArtifactRole = DEFAULT_WRITER_ROLE) {
    claimWriter(this.namespace, this.token);
  }

  public run<T>(label: string, operation: () => T | Promise<T>): Promise<T> {
    if (this.active) {
      return Promise.reject(new Error(`mesh_hub_reentrant_command_rejected:${label}`));
    }
    const execute = async () => {
      this.active = true;
      try {
        return await operation();
      } finally {
        this.active = false;
      }
    };
    const next = this.tail.then(execute, execute);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  public close(): void {
    releaseWriter(this.namespace, this.token);
  }

  public getNamespace(): string {
    return this.namespace;
  }

  public getWriterRole(): GovernedArtifactRole {
    return this.writerRole;
  }
}

export class MeshMessageBroker {
  private readonly loop: MeshHubCommandLoop;

  constructor(private readonly options: MeshHubCommandLoopOptions = {}) {
    this.loop = new MeshHubCommandLoop(options.namespace || '', options.writerRole || DEFAULT_WRITER_ROLE);
  }

  public close(): void {
    this.loop.close();
  }

  public acceptMeshRequest(request: MeshRequest, options: { now?: string; retryPolicy?: Partial<MeshRetryPolicy> } = {}): Promise<MeshHubAcceptResult> {
    return this.loop.run('acceptMeshRequest', async () => {
      const namespace = this.options.namespace || '';
      const current = findCurrentDeliveryByIdempotency(request, namespace);
      if (current) {
        return { accepted: true, delivery: current, duplicate: true };
      }

      validateFreshRequest(request, options.now);
      const route = buildRoute(request, DEFAULT_POLICY_VERSION);
      const deliveryId = deliveryIdForRequest(request);
      const messageId = randomId('mhm');
      const expiresAt = requestExpiryIso(request);
      const accepted = buildDeliverySnapshot({
        delivery_id: deliveryId,
        message_id: messageId,
        request_id: request.request_id,
        tenant_scope: request.tenant_scope,
        request_kind: request.request_kind,
        target: request.target,
        payload: request.payload,
        route,
        status: 'accepted',
        created_at: options.now || nowIso(),
        idempotency_key: request.idempotency_key,
        expires_at: expiresAt,
      });
      appendRecord(this.loop.getWriterRole(), deliveriesPath(namespace), accepted);
      writeDeliveryEvent(namespace, accepted, 'delivery_accepted', this.loop.getWriterRole());

      const queued = buildDeliverySnapshot({
        ...accepted,
        status: 'queued',
      });
      appendRecord(this.loop.getWriterRole(), deliveriesPath(namespace), queued);
      writeDeliveryEvent(namespace, queued, 'delivery_queued', this.loop.getWriterRole());

      return {
        accepted: true,
        delivery: queued,
        duplicate: false,
      };
    });
  }

  public enqueueMeshDelivery(routeDecision: MeshHubRouteDecision, options: { now?: string; retryPolicy?: Partial<MeshRetryPolicy> } = {}): Promise<MeshDeliveryRecord> {
    return this.loop.run('enqueueMeshDelivery', async () => {
      const namespace = this.options.namespace || '';
      const current = findCurrentDeliveryByIdempotency(routeDecision.request, namespace);
      if (current) return current;

      const policyVersion = routeDecision.policy_version || DEFAULT_POLICY_VERSION;
      const route = routeDecision.route || buildRoute(routeDecision.request, policyVersion);
      const deliveryId = deliveryIdForRequest(routeDecision.request);
      const messageId = randomId('mhm');
      const expiresAt = requestExpiryIso(routeDecision.request);
      const accepted = buildDeliverySnapshot({
        delivery_id: deliveryId,
        message_id: messageId,
        request_id: routeDecision.request.request_id,
        tenant_scope: routeDecision.request.tenant_scope,
        request_kind: routeDecision.request.request_kind,
        target: routeDecision.request.target,
        payload: routeDecision.request.payload,
        route,
        status: 'accepted',
        created_at: options.now || nowIso(),
        idempotency_key: routeDecision.request.idempotency_key,
        expires_at: expiresAt,
      });
      appendRecord(this.loop.getWriterRole(), deliveriesPath(namespace), accepted);
      writeDeliveryEvent(namespace, accepted, 'delivery_accepted', this.loop.getWriterRole());

      const queued = buildDeliverySnapshot({
        ...accepted,
        route,
        status: 'queued',
      });
      appendRecord(this.loop.getWriterRole(), deliveriesPath(namespace), queued);
      writeDeliveryEvent(namespace, queued, 'delivery_queued', this.loop.getWriterRole());
      return queued;
    });
  }

  public claimDueMeshDeliveries(now: string, limit = 1): Promise<MeshDeliveryRecord[]> {
    return this.loop.run('claimDueMeshDeliveries', async () => {
      const namespace = this.options.namespace || '';
      const dueAt = nowMs(now);
      const current = loadCurrentDeliveries(namespace)
        .filter((record) => record.status === 'queued')
        .filter((record) => {
          const candidate = record.retry_at ? nowMs(record.retry_at) : nowMs(record.created_at);
          return candidate <= dueAt;
        })
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.delivery_id.localeCompare(b.delivery_id))
        .slice(0, Math.max(0, limit));

      const claimed: MeshDeliveryRecord[] = [];
      for (const record of current) {
        const next: MeshDeliveryRecord = {
          ...record,
          status: 'dispatched',
          attempt_count: record.attempt_count + 1,
        };
        appendRecord(this.loop.getWriterRole(), deliveriesPath(namespace), next);
        writeDeliveryEvent(namespace, next, 'delivery_dispatched', this.loop.getWriterRole());
        claimed.push(next);
      }
      return claimed;
    });
  }

  public acknowledgeMeshDelivery(deliveryId: string, receipt: MeshDeliveryReceipt = {}): Promise<MeshDeliveryRecord> {
    return this.loop.run('acknowledgeMeshDelivery', async () => {
      const namespace = this.options.namespace || '';
      const current = loadCurrentDelivery(deliveryId, namespace);
      if (!current) {
        throw new Error(`mesh_delivery_not_found:${deliveryId}`);
      }
      if (nowMs(receipt.acknowledged_at || nowIso()) >= nowMs(current.expires_at)) {
        throw new Error(`mesh_delivery_expired:${deliveryId}`);
      }
      const next: MeshDeliveryRecord = {
        ...current,
        status: receipt.completed ? 'completed' : 'acknowledged',
      };
      appendRecord(this.loop.getWriterRole(), deliveriesPath(namespace), next);
      writeDeliveryEvent(namespace, next, receipt.completed ? 'delivery_completed' : 'delivery_acknowledged', this.loop.getWriterRole());
      return next;
    });
  }

  public rejectMeshDelivery(
    deliveryId: string,
    reason: string | { code?: string; redacted_reason?: string; failure_class?: MeshFailureClass } = 'recipient_rejected',
  ): Promise<MeshDeliveryRecord> {
    return this.loop.run('rejectMeshDelivery', async () => {
      const namespace = this.options.namespace || '';
      const current = loadCurrentDelivery(deliveryId, namespace);
      if (!current) {
        throw new Error(`mesh_delivery_not_found:${deliveryId}`);
      }
      const failureClass = typeof reason === 'string' ? 'recipient_rejected' : reason.failure_class || 'recipient_rejected';
      if (nowMs(nowIso()) >= nowMs(current.expires_at)) {
        throw new Error(`mesh_delivery_expired:${deliveryId}`);
      }
      const next: MeshDeliveryRecord = {
        ...current,
        status: 'rejected',
        failure_class: failureClass,
      };
      appendRecord(this.loop.getWriterRole(), deliveriesPath(namespace), next);
      const deadLetter = buildDeadLetter(next, failureClass, reason);
      appendRecord(this.loop.getWriterRole(), deadLettersPath(namespace), deadLetter);
      writeDeliveryEvent(namespace, next, 'delivery_rejected', this.loop.getWriterRole());
      return next;
    });
  }

  public retryMeshDelivery(deliveryId: string, now: string, retryPolicy: Partial<MeshRetryPolicy> = {}): Promise<MeshDeliveryRecord> {
    return this.loop.run('retryMeshDelivery', async () => {
      const namespace = this.options.namespace || '';
      const current = loadCurrentDelivery(deliveryId, namespace);
      if (!current) {
        throw new Error(`mesh_delivery_not_found:${deliveryId}`);
      }
      if (nowMs(now) >= nowMs(current.expires_at)) {
        const expired: MeshDeliveryRecord = {
          ...current,
          status: 'expired',
          failure_class: 'expired',
        };
        appendRecord(this.loop.getWriterRole(), deliveriesPath(namespace), expired);
        const deadLetter = buildDeadLetter(expired, 'expired', 'expired');
        appendRecord(this.loop.getWriterRole(), deadLettersPath(namespace), deadLetter);
        writeDeliveryEvent(namespace, expired, 'delivery_expired', this.loop.getWriterRole());
        return expired;
      }
      if (current.status === 'expired' || current.status === 'dead_lettered' || current.status === 'rejected' || current.status === 'acknowledged' || current.status === 'completed') {
        throw new Error(`mesh_delivery_not_retryable:${deliveryId}`);
      }
      const policy = normalizeRetryPolicy(retryPolicy);
      const nextAttempt = current.attempt_count + 1;
      if (nextAttempt >= policy.max_attempts) {
        const next: MeshDeliveryRecord = {
          ...current,
          status: 'dead_lettered',
          attempt_count: nextAttempt,
          failure_class: 'transport_error',
        };
        appendRecord(this.loop.getWriterRole(), deliveriesPath(namespace), next);
        const deadLetter = buildDeadLetter(next, 'transport_error', 'retry_exhausted');
        appendRecord(this.loop.getWriterRole(), deadLettersPath(namespace), deadLetter);
        writeDeliveryEvent(namespace, next, 'delivery_dead_lettered', this.loop.getWriterRole());
        return next;
      }
      const retryAt = new Date(nowMs(now) + nextRetryDelayMs(nextAttempt, policy)).toISOString();
      const next: MeshDeliveryRecord = {
        ...current,
        status: 'queued',
        attempt_count: nextAttempt,
        retry_at: retryAt,
        failure_class: 'transport_error',
      };
      appendRecord(this.loop.getWriterRole(), deliveriesPath(namespace), next);
      writeDeliveryEvent(namespace, next, 'delivery_requeued', this.loop.getWriterRole());
      return next;
    });
  }

  public expireMeshDeliveries(now: string): Promise<MeshDeliveryRecord[]> {
    return this.loop.run('expireMeshDeliveries', async () => {
      const namespace = this.options.namespace || '';
      const nowValue = nowMs(now);
      const expired: MeshDeliveryRecord[] = [];
      for (const record of loadCurrentDeliveries(namespace)) {
        if (record.status !== 'queued' && record.status !== 'dispatched' && record.status !== 'accepted') continue;
        if (nowValue < nowMs(record.expires_at)) continue;
        const next: MeshDeliveryRecord = {
          ...record,
          status: 'expired',
          failure_class: 'expired',
        };
        appendRecord(this.loop.getWriterRole(), deliveriesPath(namespace), next);
        const deadLetter = buildDeadLetter(next, 'expired', 'expired');
        appendRecord(this.loop.getWriterRole(), deadLettersPath(namespace), deadLetter);
        writeDeliveryEvent(namespace, next, 'delivery_expired', this.loop.getWriterRole());
        expired.push(next);
      }
      return expired;
    });
  }

  public listMeshDeadLetters(filter: MeshDeadLetterFilter = {}): Promise<MeshDeadLetterRecord[]> {
    return this.loop.run('listMeshDeadLetters', async () => {
      const namespace = this.options.namespace || '';
      return loadCurrentDeadLetters(namespace).filter((record) => {
        if (filter.delivery_id && record.delivery_id !== filter.delivery_id) return false;
        if (filter.request_id && record.request_id !== filter.request_id) return false;
        if (filter.tenant_id && record.tenant_scope.tenant_id !== filter.tenant_id) return false;
        if (filter.failure_class && record.failure_class !== filter.failure_class) return false;
        if (filter.status && record.status !== filter.status) return false;
        return true;
      });
    });
  }
}

let defaultBroker: MeshMessageBroker | null = null;

function getDefaultBroker(): MeshMessageBroker {
  if (!defaultBroker) {
    defaultBroker = new MeshMessageBroker();
  }
  return defaultBroker;
}

export function createMeshMessageBroker(options: MeshHubCommandLoopOptions = {}): MeshMessageBroker {
  return new MeshMessageBroker(options);
}

export async function acceptMeshRequest(request: MeshRequest, options: { now?: string; retryPolicy?: Partial<MeshRetryPolicy> } = {}): Promise<MeshHubAcceptResult> {
  return getDefaultBroker().acceptMeshRequest(request, options);
}

export async function enqueueMeshDelivery(routeDecision: MeshHubRouteDecision, options: { now?: string; retryPolicy?: Partial<MeshRetryPolicy> } = {}): Promise<MeshDeliveryRecord> {
  return getDefaultBroker().enqueueMeshDelivery(routeDecision, options);
}

export async function claimDueMeshDeliveries(now: string, limit = 1): Promise<MeshDeliveryRecord[]> {
  return getDefaultBroker().claimDueMeshDeliveries(now, limit);
}

export async function acknowledgeMeshDelivery(deliveryId: string, receipt: MeshDeliveryReceipt = {}): Promise<MeshDeliveryRecord> {
  return getDefaultBroker().acknowledgeMeshDelivery(deliveryId, receipt);
}

export async function rejectMeshDelivery(
  deliveryId: string,
  reason: string | { code?: string; redacted_reason?: string; failure_class?: MeshFailureClass } = 'recipient_rejected',
): Promise<MeshDeliveryRecord> {
  return getDefaultBroker().rejectMeshDelivery(deliveryId, reason);
}

export async function retryMeshDelivery(deliveryId: string, now: string, retryPolicy: Partial<MeshRetryPolicy> = {}): Promise<MeshDeliveryRecord> {
  return getDefaultBroker().retryMeshDelivery(deliveryId, now, retryPolicy);
}

export async function expireMeshDeliveries(now: string): Promise<MeshDeliveryRecord[]> {
  return getDefaultBroker().expireMeshDeliveries(now);
}

export async function listMeshDeadLetters(
  filter: MeshDeadLetterFilter = {},
  options: { namespace?: string } = {},
): Promise<MeshDeadLetterRecord[]> {
  const namespace = options.namespace || '';
  return loadCurrentDeadLetters(namespace).filter((record) => {
    if (filter.delivery_id && record.delivery_id !== filter.delivery_id) return false;
    if (filter.request_id && record.request_id !== filter.request_id) return false;
    if (filter.tenant_id && record.tenant_scope.tenant_id !== filter.tenant_id) return false;
    if (filter.failure_class && record.failure_class !== filter.failure_class) return false;
    if (filter.status && record.status !== filter.status) return false;
    return true;
  });
}

export async function listMeshDeliveries(namespace?: string): Promise<MeshHubDeliveryRecord[]> {
  return loadCurrentDeliveries(namespace);
}

export function clearMeshMessageBrokerNamespace(namespace?: string): void {
  const normalized = normalizeNamespace(namespace);
  const root = normalized ? `${meshHubRoot(normalized)}` : meshHubRoot();
  const obsRoot = normalized ? `${meshHubObservabilityRoot(normalized)}` : meshHubObservabilityRoot();
  withExecutionContext(DEFAULT_WRITER_ROLE, () => {
    if (safeExistsSync(root)) safeRmSync(root, { recursive: true, force: true });
    if (safeExistsSync(obsRoot)) safeRmSync(obsRoot, { recursive: true, force: true });
  });
}
