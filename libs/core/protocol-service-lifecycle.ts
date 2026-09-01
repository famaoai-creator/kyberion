import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { appendGovernedArtifactJsonl, type GovernedArtifactRole } from './artifact-store.js';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';
import { parseSafeJsonInput } from './foundation/json.js';
import { isRecord } from './foundation/text.js';
import { getProtocolServiceRegistryEntry } from './protocol-service-registry.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReadFile } from './secure-io.js';

export type ProtocolServiceLifecycleAction =
  'start' | 'stop' | 'reconnect' | 'restore' | 'restore_quarantine' | 'health_check';

export type ProtocolServiceLifecycleStatus =
  | 'started'
  | 'stopped'
  | 'reconnected'
  | 'restored'
  | 'quarantined'
  | 'healthy'
  | 'unhealthy'
  | 'failed';

export interface ProtocolServiceLifecycleReceipt {
  kind: 'protocol-service-lifecycle-receipt.v1';
  receipt_id: string;
  service_id: string;
  action: ProtocolServiceLifecycleAction;
  status: ProtocolServiceLifecycleStatus;
  occurred_at: string;
  scope: EventScope;
  actor_role: GovernedArtifactRole;
  requested_by?: string;
  principal?: { kind: 'nhi' | 'human' | 'service'; id: string };
  correlation_id?: string;
  reason?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface RecordProtocolServiceLifecycleInput {
  serviceId: string;
  action: ProtocolServiceLifecycleAction;
  status: ProtocolServiceLifecycleStatus;
  scope: EventScopeInput;
  actorRole?: GovernedArtifactRole;
  requestedBy?: string;
  principal?: ProtocolServiceLifecycleReceipt['principal'];
  correlationId?: string;
  reason?: string;
  metadata?: Record<string, string | number | boolean | null>;
  occurredAt?: string | Date;
  receiptId?: string;
}

const LIFECYCLE_ROOT = 'active/shared/observability/protocol-services';
const LIFECYCLE_ACTIONS: readonly ProtocolServiceLifecycleAction[] = [
  'start',
  'stop',
  'reconnect',
  'restore',
  'restore_quarantine',
  'health_check',
];
const LIFECYCLE_STATUSES: readonly ProtocolServiceLifecycleStatus[] = [
  'started',
  'stopped',
  'reconnected',
  'restored',
  'quarantined',
  'healthy',
  'unhealthy',
  'failed',
];
const GOVERNED_ARTIFACT_ROLES: readonly GovernedArtifactRole[] = [
  'slack_bridge',
  'chronos_gateway',
  'surface_runtime',
  'mission_controller',
  'infrastructure_sentinel',
  'sovereign_concierge',
];
const SCOPE_KEYS = [
  'scope_kind',
  'tier',
  'tenant_slug',
  'organization_id',
  'project_id',
  'mission_id',
  'task_id',
  'session_id',
  'work_shape',
] as const;

function iso(value?: string | Date): string {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('[PROTOCOL_LIFECYCLE_INVALID_TIMESTAMP]');
  return date.toISOString();
}

function safeSegment(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || !/^[a-zA-Z0-9._-]+$/u.test(normalized)) {
    throw new Error(`[PROTOCOL_LIFECYCLE_INVALID_${label.toUpperCase()}]`);
  }
  return normalized;
}

function sameScope(left: EventScope, right: EventScope): boolean {
  return SCOPE_KEYS.every((key) => left[key] === right[key]);
}

function sanitizeLifecycleMetadata(
  metadata?: Record<string, string | number | boolean | null>
): Record<string, string | number | boolean | null> | undefined {
  if (!metadata) return undefined;
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      typeof value === 'string' &&
      (key === 'archive' || key === 'target' || /(?:^|_)path$/u.test(key) || key === 'artifact_ref')
        ? portableProtocolServicePathRef(value)
        : value,
    ])
  );
}

function validateReceipt(
  value: unknown,
  serviceId: string,
  expectedScope?: EventScope
): ProtocolServiceLifecycleReceipt {
  if (!isRecord(value))
    throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] record must be an object');
  if (value.kind !== 'protocol-service-lifecycle-receipt.v1') {
    throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] unsupported kind');
  }
  if (typeof value.receipt_id !== 'string' || !value.receipt_id.trim()) {
    throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] receipt_id is required');
  }
  if (value.service_id !== serviceId) {
    throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] service_id does not match the stream');
  }
  if (!LIFECYCLE_ACTIONS.includes(value.action as ProtocolServiceLifecycleAction)) {
    throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] action is invalid');
  }
  if (!LIFECYCLE_STATUSES.includes(value.status as ProtocolServiceLifecycleStatus)) {
    throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] status is invalid');
  }
  if (
    typeof value.occurred_at !== 'string' ||
    Number.isNaN(new Date(value.occurred_at).getTime())
  ) {
    throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] occurred_at is invalid');
  }
  if (!GOVERNED_ARTIFACT_ROLES.includes(value.actor_role as GovernedArtifactRole)) {
    throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] actor_role is invalid');
  }
  for (const key of ['requested_by', 'correlation_id', 'reason'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim())) {
      throw new Error(`[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] ${key} is invalid`);
    }
  }
  if (!isRecord(value.scope)) {
    throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] scope is required');
  }
  let scope: EventScope;
  try {
    scope = normalizeEventScope(value.scope as EventScopeInput);
  } catch {
    throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] scope is invalid');
  }
  if (expectedScope && !sameScope(scope, expectedScope)) {
    throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] scope does not match the stream');
  }
  if (value.principal !== undefined) {
    if (
      !isRecord(value.principal) ||
      !['nhi', 'human', 'service'].includes(String(value.principal.kind)) ||
      typeof value.principal.id !== 'string' ||
      !value.principal.id.trim()
    ) {
      throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] principal is invalid');
    }
  }
  if (value.metadata !== undefined) {
    if (
      !isRecord(value.metadata) ||
      Object.values(value.metadata).some(
        (entry) => entry !== null && !['string', 'number', 'boolean'].includes(typeof entry)
      )
    ) {
      throw new Error('[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] metadata is invalid');
    }
  }
  return { ...value, scope } as unknown as ProtocolServiceLifecycleReceipt;
}

function lifecycleLogicalPath(serviceId: string, scope: EventScope): string {
  const serviceSegment = safeSegment(serviceId, 'service_id');
  const scopeSegment = scope.tenant_slug
    ? `tenants/${safeSegment(scope.tenant_slug, 'tenant')}`
    : 'system';
  return `${LIFECYCLE_ROOT}/${serviceSegment}/${scopeSegment}/lifecycle.jsonl`;
}

export function protocolServiceLifecycleLogicalPath(
  serviceId: string,
  scopeInput: EventScopeInput
): string {
  getProtocolServiceRegistryEntry(serviceId);
  return lifecycleLogicalPath(serviceId, normalizeEventScope(scopeInput));
}

export function recordProtocolServiceLifecycle(
  input: RecordProtocolServiceLifecycleInput
): ProtocolServiceLifecycleReceipt {
  const registryEntry = getProtocolServiceRegistryEntry(input.serviceId);
  if (!registryEntry.lifecycle_actions.includes(input.action)) {
    throw new Error(
      `[PROTOCOL_LIFECYCLE_ACTION_NOT_REGISTERED] ${registryEntry.id}:${input.action}`
    );
  }
  const scope = normalizeEventScope(input.scope);
  const actorRole = input.actorRole || 'infrastructure_sentinel';
  const receipt: ProtocolServiceLifecycleReceipt = {
    kind: 'protocol-service-lifecycle-receipt.v1',
    receipt_id: input.receiptId || `psl-${randomUUID()}`,
    service_id: registryEntry.id,
    action: input.action,
    status: input.status,
    occurred_at: iso(input.occurredAt),
    scope,
    actor_role: actorRole,
    ...(input.requestedBy ? { requested_by: input.requestedBy } : {}),
    ...(input.principal ? { principal: input.principal } : {}),
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.metadata ? { metadata: sanitizeLifecycleMetadata(input.metadata) } : {}),
  };
  const validated = validateReceipt(receipt, registryEntry.id, scope);
  appendGovernedArtifactJsonl(actorRole, lifecycleLogicalPath(registryEntry.id, scope), validated);
  return validated;
}

/** Record observability without turning a completed service operation into a false failure. */
export function recordProtocolServiceLifecycleBestEffort(
  input: RecordProtocolServiceLifecycleInput
): ProtocolServiceLifecycleReceipt | null {
  try {
    return recordProtocolServiceLifecycle(input);
  } catch {
    return null;
  }
}

/**
 * Convert a path before it enters shared observability. In-repository paths stay
 * portable; external absolute paths are represented by a stable opaque ref.
 */
export function portableProtocolServicePathRef(value: string): string {
  const normalized = pathResolver.toRepoRelative(String(value || '')).replaceAll('\\', '/');
  if (!normalized || (!path.isAbsolute(normalized) && !/^[A-Za-z]:\//u.test(normalized))) {
    return normalized;
  }
  return `external-path:${createHash('sha256').update(normalized).digest('hex').slice(0, 20)}`;
}

export function readProtocolServiceLifecycleReceipts(
  serviceId: string,
  scopeInput: EventScopeInput
): ProtocolServiceLifecycleReceipt[] {
  const logicalPath = protocolServiceLifecycleLogicalPath(serviceId, scopeInput);
  const absolutePath = assertSafeRepositoryPath(pathResolver.resolve(logicalPath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(absolutePath)) return [];
  const lines = String(safeReadFile(absolutePath, { encoding: 'utf8' }) || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const expectedScope = normalizeEventScope(scopeInput);
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = parseSafeJsonInput(line, `protocol lifecycle receipt line ${index + 1}`);
    } catch {
      throw new Error(`[PROTOCOL_LIFECYCLE_RECEIPT_INVALID] invalid JSON at line ${index + 1}`);
    }
    return validateReceipt(parsed, serviceId, expectedScope);
  });
}
